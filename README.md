# omp-discord-bot

A private, owner-only Discord bridge for the [`omp`](https://github.com/can1357/oh-my-pi) coding agent.
You write (or speak) to a bot in your own Discord server; it runs `omp -p` on your Linux machine and
replies in a thread. Share a link from your phone's share sheet into a channel and an agent works on it.

Runs are **sandboxed by capability** (bubblewrap, no network except a filtering proxy, no keys, no
secrets, read-only outside git work trees). Anything the sandbox cannot do goes through a
**password-gated approval broker** on the host.

Discord look and behavior (queue, notifications, slash commands, restarts) are documented in
[docs/UX-DECISIONS.md](docs/UX-DECISIONS.md).

## Features

- **Owner-only routing.** Only messages whose real author is the configured owner (not a bot, webhook or
  system message), in the configured server or a DM with the owner, ever reach an agent
  (`src/policy.ts`). Everything the bridge produces itself is labelled as bridge provenance and never
  carries owner authority.
- **Channel → working directory map.** A top-level message in a mapped channel opens a thread and starts a
  run in that channel's directory; messages in the thread continue the same `omp` session. DMs have one
  rolling session (`!new` starts a fresh one).
- **Queue.** Up to `OMP_BOT_MAX_CONCURRENT` runs (default 2, one per thread), the rest wait FIFO. A single
  live queue message per channel, ⏳/⚙️/✅/❌ reactions, a Working… message with a heartbeat (alive / quiet /
  stuck, running tool, CPU), ❌ Stop / Cancel buttons and ↩️ Undo after a stop. 30 min limit per run.
- **Outbound privacy filter** on every message (`src/redact.ts`, `src/secrets.ts`): brokerage account
  numbers, SSN-like numbers, labelled ID-document numbers, common API/Discord/GitHub tokens, plus the exact
  values of secret-looking keys found in `.env`-style files and the bot token.
- **Long answers** are split at 2000 chars with code fences intact; answers over 8000 chars become a preview
  plus `answer.md`. Fenced "paste blocks" are posted as their own messages for easy copying on a phone.
- **Multiple-choice questions.** A run can end with a fenced ```` ```ask ```` JSON block; the bridge shows
  numbered buttons (owner only) and sends the picks back as the owner's next turn.
- **Voice.** Voice messages are transcribed locally (Whisper) and answered like typed text; every answer can
  carry a locally synthesized spoken reply (Kokoro TTS). In a configured voice channel the bot holds a spoken
  conversation: only the owner's audio is subscribed to, nothing is stored.
- **Herdr mirroring (optional).** Each `omp` pane in Herdr gets a Discord channel;
  final replies from the terminal are posted there, and messages in the channel continue the pane's session
  in the sandbox (or a linked side session while the pane is busy). It never types into panes, with one
  guarded exception: the owner's "Send to FIRSTMATE" button, which only delivers when the configured pane is
  idle and its input box is empty.
- **Slash commands (owner only):** `/cpu /gpu /memory /stats /disk /services /logs /restart /panes /net
  /stream /remind /updates /usage /rgb /help`, plus `/mac` when a second machine is configured. `/restart`
  asks first and restarts the bot itself only when it is idle.
- **Loopback post endpoint** for local services: `POST 127.0.0.1:47821/post` with
  `{"channel": "<name or id>", "text": "..."}` posts to a mapped or alert channel through the same filter.

## Requirements

- Linux with user systemd, [Bun](https://bun.sh) (tested with 1.4), and bubblewrap (`bwrap`) for the sandbox.
- The [`omp`](https://github.com/can1357/oh-my-pi) CLI, signed in (default path
  `~/.local/share/mise/shims/omp`; override with `OMP_BOT_OMP_BIN`).
- Your repos under `~/Github`: that is the sandbox's workspace root (git work trees there are writable,
  everything else is read-only).
- Optional: Herdr (mirroring, approval tabs, "Send to FIRSTMATE"), the HEELER iOS app
  (deep links), ffmpeg + an NVIDIA GPU for the local Whisper/Kokoro voice services, Tailscale (`/net`).

## Setup

1. **Create the Discord app.** In the [Developer Portal](https://discord.com/developers/applications) create
   an application, add a bot, enable the **Message Content** intent, and invite it to your own private server
   with the scopes `bot` and `applications.commands` (permissions: view channels, send messages, create and
   send in threads, manage channels for mirroring, add reactions, attach files, connect/speak for voice).
2. **Token.** Put it in `~/.config/omp-discord/bot.env` (mode 600, never in git):

   ```sh
   mkdir -p ~/.config/omp-discord && umask 077
   printf 'DISCORD_BOT_TOKEN=%s\n' '<your bot token>' > ~/.config/omp-discord/bot.env
   ```

3. **Config.** Copy the example and fill in your ids (Discord → Settings → Advanced → Developer Mode, then
   right-click → Copy ID):

   ```sh
   cp config.example.json ~/.config/omp-discord/config.json
   $EDITOR ~/.config/omp-discord/config.json
   ```

   A different path can be given with `OMP_BOT_CONFIG`. The bot refuses to start, with a message saying
   what is wrong, while the file is missing or still holds placeholders.
4. **Install and check.**

   ```sh
   bun install
   bun run typecheck && bun test
   ```

5. **Run as a user service.** Adjust `WorkingDirectory` in `systemd/omp-discord-bot.service` if the repo is
   not at `~/Github/tools/omp-discord-bot`, then:

   ```sh
   cp systemd/omp-discord-bot.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now omp-discord-bot
   journalctl --user -u omp-discord-bot -f
   ```

   `systemd/omp-whisper.service` and `systemd/omp-tts.service` are the optional local speech services.

### Config keys (`config.json`)

| key | required | meaning |
|---|---|---|
| `ownerId` | yes | Your Discord user id. The only account the bot listens to. |
| `guildId` | yes | Your private server's id. |
| `channels` | yes | `{ "<channel id>": { "name": "general", "cwd": "~/Github" } }`. Only these start runs. |
| `alertChannels` | no | Post-only channels for the loopback endpoint (never start runs). |
| `devChannelId` | no | Where self-tests, CLI approvals and channel-delete notices go. |
| `dmCwd` | no | Working directory for DMs (default `~/Github`). |
| `voice.channelId` / `transcriptChannelId` / `fallbackChannelId` | no | Voice mode channel, its transcript log, and the run channel used before you have written anywhere. Voice mode is off without `channelId`. |
| `mirror.categories.rig` / `mac` / `archive` | no | Category ids for mirrored Herdr panes. Mirroring is off without `rig` and `archive`. |
| `mirror.macSshHost` | no | SSH host of a second machine whose panes are mirrored too (enables `/mac`). |
| `firstmate.pane` / `tabLabel` | no | Herdr pane for the "Send to FIRSTMATE" button and its tab label. |
| `workingEmoji` | no | Emoji shown while a job runs (default ⚙️; `scripts/make-spin-gear.ts` uploads an animated one). |
| `heeler.host` / `redirect` | no | HEELER deep links: Herdr host name and your redirect page (`heeler-link/`). |
| `egress.denyIps` / `denyHostSuffixes` | no | Extra public destinations the sandbox proxy must refuse (for example a VPS that should only be reachable over SSH from the host). |
| `smtp.host` / `port` | no | Fixed SMTP tunnel for `neomutt` inside the sandbox. No mail from sandboxed runs without it. |
| `services` / `restartable` | no | `/services`, `/logs` and `/restart`: label → systemd user unit, and which labels may be restarted. |
| `pingHosts` | no | `/net`: label → host to ping. |
| `hostLabel` | no | Name of this machine in messages (default `rig`). |

Env overrides: `OMP_BOT_CONFIG`, `OMP_BOT_MAX_CONCURRENT`, `OMP_BOT_TIMEOUT_MIN`, `OMP_BOT_STATE_DIR`,
`OMP_BOT_OMP_BIN`, `OMP_BOT_HTTP_PORT`, `OMP_BOT_APPROVAL_WORKSPACE`, `OMP_BOT_FIRSTMATE_PANE`,
`OMP_BOT_HEELER_HOST`, `OMP_BOT_HEELER_REDIRECT`, `OMP_BOT_RGB_SWITCH`, `OMP_WORKING_EMOJI`.

## Security model

- **Owner only.** Messages, buttons, menus and slash commands from anyone but `ownerId` are ignored or get a
  private refusal. Approval requests are only posted to the owner's own server or DM. Bot messages never ping.
- **Sandboxed mode (default).** Each run is `bwrap --unshare-all` with the whole file system read-only except
  git work trees under `~/Github`, a private `/tmp`, `~/discord-scratch` and `~/.cache`:
  - Network only through an HTTP/CONNECT proxy (`src/egress.ts`) that refuses loopback, private, CGNAT
    (tailnet), link-local and reserved addresses, single-label hosts, `*.ts.net`, and anything in `egress`.
    DNS is resolved by the proxy and pinned (no rebinding).
  - No SSH keys or agents, no GPG, no 1Password, no keyrings, no browser profiles, no D-Bus, no host sockets,
    no bot token or config; every `.env`/key/credential file under `~/Github` and `~/.config` is masked.
    `no_new_privs`, so `sudo` cannot work.
  - Repos that your user services run (found in `~/.config/systemd/user`), this bridge, and every tree's
    `.git/hooks` and `.git/config` stay read-only.
  - A few host commands run through a validating broker outside the sandbox (`src/hostexec.ts`): https
    `git push/fetch/pull/clone`, `gh` (not auth), `systemctl --user` read verbs, `herdr` read commands,
    `op item list/get` (names only).
  - Everything else goes through `omp-approve --reason '<why>' -- '<exact command>'`. The bridge posts the
    exact command in the thread and opens an "Approve <id>" Herdr tab running `gate/approve.ts`, which
    verifies your **login password through PAM** (`sudo -v`, never seen by the script), re-checks the
    entry's hash, runs the command once and posts the receipt. `!deny <id>` or expiry cancels.
- **Trusted mode (opt-in).** While `~/.config/omp-discord/trusted` exists, runs are not sandboxed: they run as
  your user like `omp` in a terminal, approvals are a Discord **Approve** button, and answers may attach
  files (`📎 attach: <path>`, from a fixed set of folders only). Switch it with `scripts/trusted.sh
  on|off|status`; `off` removes the passwordless-sudo drop-in first. Only enable it if you accept that anyone
  who controls your Discord account controls your machine.
- The loopback endpoint only accepts requests with a loopback `Host`, no browser `Origin`, and JSON bodies.

## Useful scripts and checks

- `bun test`: unit tests. `OMP_SANDBOX_INT=1 bun test test/sandbox.int.test.ts` adds real bwrap probes
  (needs bwrap, `~/Github` and internet access). The voice pipeline test runs only when the local
  Whisper/TTS sockets exist.
- `bun src/sandbox-cli.ts [--key K] [--cwd DIR] -- <cmd…>`: run any command in the same sandbox.
- `bun src/selftest.ts native|gate`: live `omp -p` runs through the production path.
- `scripts/restart-when-idle.sh`, `scripts/safe-restart.sh`: restart the bot only when nothing is running.
- `bun scripts/notify-owner.ts "<text>"`: post a line to `devChannelId` (or `$OMP_NOTIFY_CHANNEL`).
- `heeler-link/`: a tiny Cloudflare Worker that turns https links into `heeler://` deep links (Discord buttons
  only accept https). Copy `wrangler.example.jsonc` to `wrangler.jsonc` and fill in your account and domain.

Chat commands: `!status` (runs and queue), `!new` (fresh session in a DM or mirrored channel),
`!deny <id>` (cancel an approval), `/queue` (show the queue).
