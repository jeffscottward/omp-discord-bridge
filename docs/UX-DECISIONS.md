# Discord UX decisions

Owner decisions for how the bot looks and behaves in Discord. Each entry says what the bot does, why, and the
date. Code comments that say "Owner 2026-10-15" point back to these entries. Change an entry only on a new owner
decision, and record the new date.

## Notifications (2026-10-15)

- **Only full answers notify.** Every status post is silent (`SuppressNotifications`): Working…, transcripts,
  queue notes, the queue message, menus, restart notices, late audio, compaction notes.
- **Three alerts stay loud on purpose:** Approve requests, "couldn't transcribe", and Herdr channel/tab warnings.
- A long answer sends **one** loud chunk: the audio chunk, or the first chunk if there is no audio.

## Queue (2026-10-15)

- **One standalone queue message per channel, always the last message.** It is reprinted below every new message.
  The reprint waits 1.2 s after the last new message and never more than 3 s (a steady stream cannot hold it back).
- Layout, top to bottom: a `━━` rule, `⏳ **Queue**` with an underline, the running job, the numbered waiting
  jobs, then a blank line and `🏁 **Finished**` with an underline and the last five results.
- **The running row has no "Now:" label.** The animated spinning gear says it.
- **Every row is a 🔗 jump link**: the running row opens its Working… message (❌ Stop); a waiting row opens its
  own `⏳ Queued.` note (Cancel).
- **No buttons on the queue message.** The owner removed the number buttons; Cancel lives on each note.
- When the queue empties, the bot posts a final `🏁 Finished` copy below the last answer. The owner's next message
  removes it.
- If the list is too long, waiting rows are cut with `… N more`; the `Restart pending` line always stays.

## Per-message status (2026-10-15)

- Each waiting message gets a silent `⏳ Queued.` note with a Cancel button.
- **When its job starts, that note is edited in place into `Working… ❌ Stop`.** The channel then reads in send
  order: ✅ done → ⚙️ working → ⏳ waiting. A job that starts at once (no note) posts Working… at the bottom.
- Reactions on the owner's message: ⏳ plus 1️⃣ 2️⃣ … while waiting, the animated spinning gear while running,
  ✅ or ❌ when done.
- **Working… shows a heartbeat:** first ~2 s after start, then every 10 s (alive / quiet / stuck, the running tool,
  CPU, log writes). It is deleted when the job ends.
- **Compaction:** when a run writes nothing to its session log for 8 s, Working… shows
  `🗜️ Compacting memory (usually ~60 s, about N s left)`. The 60 s comes from the three measured compactions
  (58–61 s). The owner chose this over switching to a fresh session before compaction.
- Do not delay replies to make tests easier (owner, 2026-10-15). Speed stays as it is.

## Voice (2026-10-15)

- A voice message is swapped for a transcript message right after transcription; the transcript carries the
  reactions, Working…, Stop and the answer's reply link.
- Spoken replies: the bot waits for speech (up to 45 s) and sends text + audio as one message. Files are named
  `REPLY-<slug>.ogg` after the request.

## Restarts (2026-10-15)

- Never restart directly. `scripts/restart-when-idle.sh` waits until nothing is running or queued, no reply is
  being posted, no queue-message reprint is pending, and the owner is not in the voice call.
- While a restart waits, the queue message shows `🔄 Restart pending: N updates ready` (or "no new code" for a
  reload). After the restart, that line is edited to `✅ Restarted: the bot is running <commit>`.
- Restart notices are framed: `━━` rule, `🤖 **Bot restart**`, an underline (same style as the queue header).

## Slash commands (2026-10-15)

- Owner only; anyone else gets a private refusal. `/help` lists them all.
- Rig: `/cpu /gpu /memory /stats /disk /services /logs /restart /panes /net /stream /mac /updates`
  (`/mac` only when a second machine is configured).
- Tools: `/usage` (AI provider limits, like `omp usage`), `/rgb` (toggle, or `state:on|off`), `/remind`.
- `/restart` asks first (private confirm button). The bot restarts only through the idle restart. Only services
  listed under `restartable` in the config can be picked.
- Commands that change state must report failure honestly: no "set" or "restarted" unless it really happened.
