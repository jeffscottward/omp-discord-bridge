export interface Job<R> {
  id: number;
  /** Session key (thread id / dm key). Jobs with the same key never run concurrently. */
  key: string;
  label: string;
  /** First words of the owner's message, for the queue stack display. */
  preview?: string;
  run: () => Promise<R>;
  onStart?: () => void | Promise<void>;
  onDone: (result: R | undefined, error?: unknown) => void | Promise<void>;
  enqueuedAt: number;
  startedAt?: number;
}

export interface JobView {
  id: number;
  key: string;
  label: string;
  preview?: string;
  since: number;
}

/** FIFO queue: at most `max` concurrent jobs, at most one per key. */
export class JobQueue<R> {
  private nextId = 1;
  private readonly pending: Job<R>[] = [];
  private readonly running = new Map<number, Job<R>>();
  /** Jobs whose run ended but whose reply (text, audio) is still being posted. */
  private finishing = 0;

  constructor(private readonly max: number) {}

  enqueue(spec: Omit<Job<R>, "id" | "enqueuedAt">): { id: number; position: number } {
    const job: Job<R> = { ...spec, id: this.nextId++, enqueuedAt: Date.now() };
    this.pending.push(job);
    this.pump();
    const idx = this.pending.indexOf(job);
    return { id: job.id, position: idx === -1 ? 0 : idx + 1 };
  }

  /** Remove a job that has not started yet. True if it was waiting. */
  cancel(id: number): boolean {
    const i = this.pending.findIndex((j) => j.id === id);
    if (i === -1) return false;
    this.pending.splice(i, 1);
    return true;
  }

  status(): { running: JobView[]; queued: JobView[]; max: number; finishing: number } {
    return {
      max: this.max,
      finishing: this.finishing,
      running: [...this.running.values()].map((j) => ({ id: j.id, key: j.key, label: j.label, preview: j.preview, since: j.startedAt! })),
      queued: this.pending.map((j) => ({ id: j.id, key: j.key, label: j.label, preview: j.preview, since: j.enqueuedAt })),
    };
  }

  private pump(): void {
    while (this.running.size < this.max) {
      const busy = new Set([...this.running.values()].map((j) => j.key));
      const idx = this.pending.findIndex((j) => !busy.has(j.key));
      if (idx === -1) return;
      const [job] = this.pending.splice(idx, 1);
      this.start(job!);
    }
  }

  private start(job: Job<R>): void {
    job.startedAt = Date.now();
    this.running.set(job.id, job);
    void (async () => {
      let result: R | undefined;
      let error: unknown;
      // Let enqueue() return first: callers' onStart/onDone use the id it returns
      // (a job that starts at once would otherwise read it before it exists).
      await Promise.resolve();
      try {
        await job.onStart?.();
        result = await job.run();
      } catch (e) {
        error = e;
      }
      this.running.delete(job.id);
      this.pump();
      this.finishing++;
      try {
        await job.onDone(result, error);
      } catch (e) {
        console.error(`job ${job.id} onDone failed: ${(e as Error).message}`);
      } finally {
        this.finishing--;
      }
    })();
  }
}
