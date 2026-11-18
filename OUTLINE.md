# OUTLINE (for AI agents)

Read this before changing the plugin. It explains how the files fit together,
the flows, the decisions behind them, and the traps. User-facing docs are in
`README.md`.

## What it is

An OpenCode **V2** plugin (`@opencode/plugin` 2.3.x, V1 is not supported) that
runs the agent's `shell` tool inside an OS sandbox: Seatbelt (`sandbox-exec`)
on macOS, bubblewrap (`bwrap`) on Linux. Opt-in per project. Two halves from one
package (`package.json` `exports`: `.` -> `index.ts`, `./tui` -> `tui.tsx`):

- **Server half** (`index.ts`): wraps shell commands (`shell.hook("create.before")`),
  runs one network proxy per session for "ask" mode, checks `webfetch` hosts,
  stores settings, serves the RPC.
- **TUI half** (`tui.tsx`): footer cube icon, settings modal with list editors,
  the "ask" popup, notifications. It has **no access to server options or
  state** and talks to the server only through the RPC in `src/rpc.ts`.

Registered in `~/.config/opencode/opencode.jsonc` as
`{ "package": "./configured-plugins/sandbox-mode", "options": { ... } }`, before
auto-mode (plugin order = footer icon order). It lives in `configured-plugins/`,
not `plugins/`: OpenCode auto-loads every directory under `plugins/` **without
options**. It's a git submodule (`HendrikPetertje/opencode-sandbox-mode`); the
user commits and pushes himself (GPG signing), agents never commit.

## File map

| File | Role | Imports from |
|---|---|---|
| `index.ts` | Server plugin: shared state, sessions and runtimes, the `decide` network pipeline, proxies, RPC handlers, hooks, idle sweep, `sandbox.log`. | everything in `src/` |
| `tui.tsx` | TUI plugin: `FooterIcon`, `Modal` (settings and list views), `AskPopup`, event listeners, tab-close tracking, keymaps, colours. | `src/rpc.ts`, `src/options.ts` (types), `src/patterns.ts` (`isValid`), `src/paths.ts` (`stateDir`) |
| `src/options.ts` | `parseOptions` (plugin options -> `Options`; `defaults` are the settings for projects not seen yet), `ProjectSettings`, `SETTING_ROWS` (modal rows incl. list rows `list:<scope>:<kind>` and the action row `openState`), `adjust` (h/l/space), `linkNetwork` (Linux: in follows out), `DEFAULT_CREDENTIALS`. | - |
| `src/state.ts` | Sync JSON files: `projects/<hash>.json` (`{ directory, settings, lists }`) and `global.json` (`{ allow, deny }`). Atomic writes (tmp + rename). | `paths.ts` |
| `src/patterns.ts` | Allow/block entries are **regexes on `host:port`**, case-insensitive, compiled once (`compile` cache). `judge`: block wins, then allow, else `ask`. `exact(target)` = escaped `^host:port$` (what the popup saves). | - |
| `src/proxy.ts` | Forward proxy on `127.0.0.1:<random>` (plus an optional unix socket): HTTP `CONNECT`, plain HTTP with absolute URLs (rewritten to origin form, `Connection: close`), SOCKS5 CONNECT. Calls `decide(target)` per connection before connecting. | - |
| `src/backend.ts` | `Backend` per OS: `probe()` (does the sandbox start?), `wrap(spec)` (the command string), `supportsAsk`, `linkedNetwork`. `seatbeltProfile` builds the SBPL profile; `bwrapArgs` the bwrap flags. | `bridge.ts`, `paths.ts` |
| `src/bridge.ts` | Linux ask mode: forwarder source (python3, else node), `findForwarder`, `prepareBridge`, `bridgePrelude` (shell snippet that starts the forwarder, waits for a ready file, then `exec "$0" -c "$1"`). | - |
| `src/paths.ts` | `stateDir()` (respects `XDG_STATE_HOME`), `projectHash`, `expandHome`, `real` (resolves symlinks of the nearest existing parent; Seatbelt needs `/private/var`, not `/var`), `isInside`. | - |
| `src/rpc.ts` | `Rpc.define`: methods `state`, `toggle`, `setSetting`, `listAdd`, `listEdit`, `listRemove`, `listPromote`, `answer`, `release`; events `changed`, `ask`, `failed`, `halted`. Loose `{type:"object"}` schemas. | `@opencode/plugin/rpc` |
| `src/sandbox.test.ts` | `bun test`: patterns, options, profiles, proxy (CONNECT, SOCKS5), a live Seatbelt run on macOS. | pure modules |

## Concepts

- **Project** = the session's `location.directory`. Settings and the project
  allow/block lists are per project.
- **Runtime** = per **root session** (subagents share their root's): its proxy,
  its one-off (a)llow/(r)eject answers (`once`), `lastUsed`. Released when the
  session's tab closes (TUI -> `release`), or by the idle sweep. The sandbox
  HOME is **per project**, not per runtime (the user chose that so caches
  survive).
- **Lists**: project allow/deny (`projects/<hash>.json`), global allow/deny
  (`global.json`), and read-only global entries from the `allow`/`deny`
  options. All count the same; block always wins.

## Flows

### A shell command (the main flow)

1. `tool.hook("execute.before")` (has `sessionID`): `sessionInfo` resolves
   directory and root session; a `shell` call is recorded in `shared.running`
   with its command and time. First tool call of a root session in an enabled
   project runs `probe()` (see "When the sandbox can't start").
2. `shell.hook("create.before")` (has only `command`, `cwd`, `shell`, `env`, no
   session): `shellOwner(cwd)` takes the **oldest unmatched** running shell call
   whose project contains the cwd (within 30 s). No match = not an agent call
   (the user's `!` command): project = deepest known session directory around
   the cwd, no session, so ask mode gets no proxy (acts as closed).
3. Project disabled, or `shared.problem` set -> return (command runs normally).
4. Build a `Spec`: settings, synthetic HOME (`homes/<projectHash>`, also set as
   `env.HOME`), credential/extra paths (from the **current** options).
5. Ask mode with a session: `proxyFor(runtime)` -> set `HTTP(S)_PROXY`,
   lowercase forms, `npm_config_*proxy`, `ALL_PROXY=socks5h://…`, `NO_PROXY`
   (localhost when that setting is on). Linux also gets `spec.bridge`.
6. `event.command = backend.wrap(spec)`, `env.OPENCODE_SANDBOX=<backend>`.
   Any exception -> the command becomes an `exit 126` with a message
   (**fail closed**: never run unwrapped by accident).
7. `tool.hook("execute.after")` removes the running entry.

### A network connection in ask mode (`decide`)

`decide(rootSessionID, "host:port", command?)`:

1. Project disabled or network out `open` -> allow; `closed` -> deny.
2. `judge` against project + global + config lists -> allow / deny.
3. The runtime's `once` answer -> that.
4. An open ask for the same session + target -> wait for it (one popup per host).
5. Otherwise create an `Ask`, log it, emit `ask`, start the timeout
   (`askTimeoutSeconds`, default 20):
   - Answer (`answer` RPC): `allow`/`reject` -> `once`; `whitelist`/`blacklist` ->
     `exact(target)` into the **project** list. Resolves the ask.
   - Timeout: resolve `false` (the command's connection fails), mark
     `timedOut`, `interrupt` the root session through the newest live copy,
     emit `halted`. The ask stays in `shared.asks` until answered, so the
     popup's answer still counts afterwards.

Callers: the proxy (per runtime, via `latest().decide`), and the `webfetch`
permission hook (see below).

### webfetch

`webfetch` runs inside OpenCode, not in the shell, so it bypasses the
sandbox. `permission.hook("evaluate")` for `action === "webfetch"` parses the
URL from `resources`, runs `decide(root, host:port, "webfetch <url>")`, and on
a refusal sets `effect = "deny"` with a message starting `sandbox-mode`
(auto-mode leaves those denies alone). MCP servers and `websearch` are not
covered (an MCP routing feature was discussed and deliberately postponed:
local MCPs could be wrapped via `ctx.mcp.transform`, remote ones only checked
per call, podman MCPs can't be contained).

### When the sandbox can't start

`probe()` (Seatbelt: run `/usr/bin/true` with an allow-all profile; bwrap: run
`true` with `--unshare-net --unshare-pid`) runs on the first tool call of
every **new** root session in an enabled project. On failure: add the root to
`shared.failed`, emit `failed` (TUI: error toast + attention notify), and
**sleep `failDelaySeconds` (4) inside `execute.before`** so the user can press
escape. After that commands run unsandboxed and the cube is red for that
session. A new session probes again.

### Releasing runtimes

- TUI: a `createRoot` effect diffs `context.ui.tabs.list()`; a session that
  left the list -> `release({ sessionID })`. No tabs enabled -> nothing.
- Server sweep (every 10 min, one interval on `shared.sweeper`): runtimes
  without shell activity or network use for 2 h are released; stale
  `running` entries are dropped.
- `release`: rejects the session's open asks, closes the proxy (TCP and unix
  socket), removes `run/<hash>` on Linux, emits `changed`.

## Backends

### macOS: Seatbelt (`seatbeltProfile`)

`(allow default)` then denies, then allows; **later rules win** in SBPL, so
order matters:

- Project-only writes: `(deny file-write*)`, then allow the project,
  `/private/tmp`, `/private/var/folders`, the sandbox HOME, `extraWritePaths`,
  `/dev/*`.
- Protect hooks: deny writes to `.git/hooks`, `.git/config`, `.opencode`, `.envrc`.
- Credentials: deny read and write on `credentialPaths`; `extraReadPaths` are
  re-allowed after that.
- Network out not open: deny outbound, allow unix sockets (DNS via
  mDNSResponder), `localhost:*` when the Localhost setting is on, and
  `localhost:<proxyPort>` in ask mode.
- Network in closed: deny `network-bind` and `network-inbound` on `*:*`.
- Paths go through `real()`: the profile must name `/private/var/...`.
- The profile is passed inline (`-p`), shell-quoted; no profile files.

### Linux: bubblewrap (`bwrapArgs`)

- Project-only writes: `--ro-bind / /`, `--tmpfs /tmp`, `--bind` project, HOME,
  `extraWritePaths`; otherwise `--bind / /`. Then `--dev`, `--proc`.
- Protected paths `--ro-bind` over themselves; credential dirs get `--tmpfs`,
  files `--ro-bind /dev/null`; `extraReadPaths` re-bound read-only last.
- Network out not open: `--unshare-net` (own empty namespace). That is why
  **network in and out are linked** (`linkedNetwork`, `linkNetwork`, `adjust(…, linked)`):
  open out = open in, ask/closed out = closed in. Localhost inside is the
  sandbox's own, so the Localhost setting shows "n/a on Linux".
- Ask mode (`spec.bridge`): the runtime's proxy also listens on
  `run/<hash>/proxy.sock`; that folder (with the forwarder script) is bound to
  `/tmp/.opencode-sandbox`, `--unshare-pid` makes the forwarder die with the
  command, and the wrapped command is
  `bwrap … /bin/sh -c <prelude> <shell> <command>`. The forwarder listens on
  the sandbox's `127.0.0.1:<same port as the host proxy>`. No python3/node ->
  `supportsAsk` is false and ask acts as closed (the modal says so).

## State and where it lives

| State | Scope | Storage |
|---|---|---|
| `ProjectSettings` + project lists | project | `~/.local/state/opencode-sandbox-mode/projects/<sha256(dir)[:16]>.json` |
| Global lists | all projects | `…/global.json` (+ `allow`/`deny` options, read-only) |
| Sandbox HOME | project | `…/homes/<hash>/` |
| Linux bridge (socket + forwarder) | runtime | `…/run/<hash(sessionID)>/`, removed on release |
| Log (ask, answer, timeout, runtime start/release, errors) | disk | `…/sandbox.log` (append only, not trimmed yet) |
| Runtimes, asks, session map, running calls, failed/checked sessions, live copies | process memory | `globalThis.__opencodeSandboxMode` |

Never write inside the config dir or a project at runtime: OpenCode watches
them and reloads plugins in a loop. Everything goes under `stateDir()`.

## Shared state and hot reloads (the biggest trap)

The server runs one copy of the plugin per location (home, each project) and a
new copy on every hot reload (editing any plugin file reloads it in the
running server). Hooks, RPC calls and proxy callbacks can each land in a
different copy, and old copies stay alive until disposed.

- **All mutable state lives on `globalThis.__opencodeSandboxMode`**, created
  field by field with `??=` so an older shared object gains new fields.
- **Long-lived things never use their creator's closures.** Proxies and ask
  timers call `latest()` = the newest entry in `shared.copies` (`{ emit,
  interrupt, decide }`), registered at setup and removed on dispose. A stale
  closure once made "allow" in the popup do nothing.
- Read options through `shared.options ?? options` in long-lived paths.
- Restart OpenCode after larger changes; a running server keeps old shared
  objects (and old `asks`) across reloads.

## TUI <-> server

- `state({ sessionID?, directory? })` returns everything the TUI renders:
  directory, `rootID`, settings, rows, lists (`project`, `global`, `config`),
  keybind, `failed`, `problem`, `backend`, `askSupported`, `linkedNetwork`,
  and the session's open asks.
- **RPC replies and event payloads must be plain JSON.** A field set to
  `undefined` fails the whole call with `rpc.invalid_output` (HTTP 500), and the
  TUI then silently does nothing (this broke the power button once). Every
  reply and emit goes through `json()`; keep it that way.
- Mutations return a fresh `state`; the server also emits `changed` and the TUI
  re-fetches every session state it holds.
- Popups: `ask` events are shown only by the TUI whose current session's root
  (`context.data.session.root`) is the ask's session (`mine()`); `halted` too.
  Asks that arrive while the window shows something else are picked up from
  `state.asks` when it switches to that session. Several OpenCode windows share
  one server, so events reach all of them.
- `answer` closes the popup first, then calls the RPC with a 5 s timeout and
  toasts any failure or `ok: false`.
- Debugging RPC by hand: the server listens on a random 127.0.0.1 port (see
  `lsof -iTCP -sTCP:LISTEN | rg opencode`), basic auth `opencode:<password from
  ~/.config/opencode/service.json>`, `POST /api/rpc/sandbox-mode/<method>` with
  body `{"input": {...}}`. The other listening port of the process may be a
  runtime proxy.

## UI

- **Icon** in `prompt.footer.status` (home and sessions): `nf-md-cube_outline`
  `\u{F01A7}` foam when on, `nf-md-cube_off_outline` `\u{F141D}` muted when off,
  love when on but failed. Codepoints come from the Nerd Fonts
  `glyphnames.json`; a wrong guess once rendered a pencil.
- **Colours** from the terminal palette via `RGBA.fromIndex` (1 love, 2 pine,
  3 gold, 4 foam, 5 iris, 8 muted) with Rosé Pine hex fallbacks.
- **Modal** (`<leader>o`, the `keybind` option; `/sandbox`; click): settings
  view and list view in one component. Keys: `j k` move, `gg G`, `h l`
  change (in lists `h` = back), `space`/`enter` change or open a list, `e`
  edit, `a` add, `dd` delete, `p` promote a project entry to global, `-`
  power, `?` long help. Arrow keys, `Home`, `End` work too but are **not
  shown in the legend** (the user's wish). No number shortcuts (more than 9 rows).
- Add/edit uses `context.ui.dialog.prompt`, which replaces the modal; the
  modal is reopened afterwards in the same list and position.
- `openState` row opens `stateDir()` in Finder (`open`) / `xdg-open`, like
  auto-mode's log row.
- Double-key sequences (`dd`, `gg`) are timestamps (600 ms), not keymap chords.

## Relation to auto-mode

The plugins never import each other; they meet on `globalThis`:

- sandbox-mode publishes `isSandboxed(directory)`; auto-mode asks the user for
  file tools reaching outside the project, and tells its reviewer about the
  sandbox for `shell`/`external_directory` reviews.
- sandbox-mode `webfetch` denies carry a `sandbox-mode` message prefix;
  auto-mode keeps them.
- Without auto-mode, OpenCode's own `external_directory` rules apply unchanged
  (the user explicitly did not want sandbox-mode to force asks itself).

## Patterns to keep

- **Fail closed** for commands we meant to sandbox but couldn't wrap; **fail
  visible** (notification, delay, red icon) when the sandbox can't start at all.
- **Pure modules + thin glue**: logic in `src/*` without OpenCode imports,
  tested in `src/sandbox.test.ts`.
- **Survive hot reloads**: see above; give new state fields `??=` defaults.
- **Never shadow Solid imports** (`on` is imported as `track`).
- **No `find`** in any tooling or docs examples (user rule); use `fd`/`rg`.

## Testing

```sh
bun test                                  # in the plugin folder, on the host (the Seatbelt test needs macOS)
bun build --no-bundle index.ts >/dev/null # syntax check; same for tui.tsx
```

Linux: run in a throwaway privileged container (unprivileged nested
namespaces fail with `RTM_NEWADDR`), install bubblewrap, mount the plugin
read-only and drive `bwrap.wrap(...)` / `startProxy(...)` with Node 24 (it
strips TypeScript; use `.mjs` test scripts without type syntax). The user's
`localhost/opc-image` image has python3 and node; don't change or remove it.
Its podman VM clock is skewed: apt needs
`-o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false`.

## Known gaps and ideas

- MCP servers and `websearch` aren't covered (see webfetch above).
- The user's `!` commands get no proxy in ask mode (no session to ask).
- `shellOwner` matches by time and cwd; two sessions in the same project
  starting shell calls at the same moment could swap runtimes (same project
  settings, only the one-off answers and popup target differ).
- macOS: unix sockets stay reachable (DNS, but also the podman/docker socket).
- `sandbox.log` grows without trimming.
- No `tsc` in the repo; type-check like auto-mode does (see its OUTLINE).
