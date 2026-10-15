/**
 * Owner 2026-10-15: when a queued job starts, its "⏳ Queued." note becomes the "Working… ❌ Stop" message
 * in place, so the channel keeps send order (✅ done → ⚙️ working → ⏳ waiting). A job with no note (it
 * started at once) posts at the bottom. If the edit fails, delete the note and post at the bottom.
 */
export interface EditableNote<M> {
  edit(payload: unknown): Promise<M>;
  delete(): Promise<unknown>;
}

export async function showWorking<M>(note: EditableNote<M> | undefined, payload: unknown, post: () => Promise<M>): Promise<M> {
  if (!note) return post();
  try {
    return await note.edit(payload);
  } catch {
    await note.delete().catch(() => {});
    return post();
  }
}

/** A note that arrives after its job already left the queue (started or cancelled) must not keep a Cancel button. */
export function noteIsLate(jobId: number, queuedIds: readonly number[]): boolean {
  return !queuedIds.includes(jobId);
}
