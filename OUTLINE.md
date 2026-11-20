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
  keeps OpenCode's config read-only (the config lock), optionally wraps local MCP
  servers (`sandboxMcp`), stores settings, serves the RPC.
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
| `tui.tsx` | TUI plugin: `FooterIcon`, `Modal` (settings, list and all-sandboxes views), `AskPopup`, event listeners, tab-close tracking, keymaps, colours. | `src/rpc.ts`, `src/options.ts` (types), `src/patterns.ts` (`isValid`), `src/paths.ts` (`stateDir`), `src/sandboxes.ts` (type `SandboxInfo`) |
| `src/options.ts` | `parseOptions` (plugin options -> `Options`; `defaults` are the settings for projects not seen yet), `ProjectSettings`, `SETTING_ROWS` (modal rows incl. list rows `list:<scope>:<kind>` and the action row `openState`), `adjust` (h/l/space), `linkNetwork` (Linux: in follows out), `DEFAULT_CREDENTIALS`, `resolveOptions` (reads the jsonc file named by the `extends` option; its keys win over the inline ones; `stripJsonc`), `lockConfig` (a setting that is never stored), `mcpProjectWrite`, `fillSettings` (defaults for keys a cached older state lacks), `homeLinks`, `sandboxMcp` entries (`{ name, args }`). | `paths.ts` |
| `src/state.ts` | `homeDir`, `mcpDirsOf`, `hasProjectFiles` and `removeProjectFiles` (home + MCP folders + `projects/<hash>.json` for one project; symlinks are removed, not followed). Sync JSON files: `projects/<hash>.json` (`{ directory, settings, lists }`) and `global.json` (`{ allow, deny }`). Atomic writes (tmp + rename). | `paths.ts` |
| `src/patterns.ts` | Allow/block entries are **regexes on `host:port`**, case-insensitive, compiled once (`compile` cache). `judge`: block wins, then allow, else `ask`. `exact(target)` = escaped `^host:port$` (what the popup saves). | - |
| `src/proxy.ts` | Forward proxy on `127.0.0.1:<random>` (plus an optional unix socket): HTTP `CONNECT`, plain HTTP with absolute URLs (rewritten to origin form, `Connection: close`), SOCKS5 CONNECT. Calls `decide(target)` per connection before connecting. | - |
| `src/backend.ts` | `Backend` per OS: `probe()` (does the sandbox start?), `wrap(spec)` (the command string), `supportsAsk`, `linkedNetwork`. `seatbeltProfile` builds the SBPL profile; `bwrapArgs` the bwrap flags. | `bridge.ts`, `paths.ts` |
| `src/bridge.ts` | Linux ask mode: forwarder source (python3, else node), `findForwarder`, `prepareBridge`, `bridgePrelude` (shell snippet that starts the forwarder, waits for a ready file, then `exec "$0" -c "$1"`). | - |
| `src/paths.ts` | `stateDir()` (respects `XDG_STATE_HOME`), `projectHash`, `expandHome`, `real` (resolves symlinks of the nearest existing parent; Seatbelt needs `/private/var`, not `/var`), `isInside`, `configDir`, `lockedPaths` (what the config lock protects), `linkIntoHome` (symlinks `homeLinks` into the sandbox home). | - |
| `src/rpc.ts` | `Rpc.define`: methods `state`, `toggle`, `setSetting`, `listAdd`, `listEdit`, `listRemove`, `listPromote`, `answer`, `release`, `removeFiles` (this project), `sandboxes` (list all), `removeSandbox` (by hash; refuses live ones); events `changed`, `ask`, `failed`, `halted`. Loose `{type:"object"}` schemas. | `@opencode/plugin/rpc` |
| `src/sandboxes.ts` | All sandboxes on the machine: per-process heartbeat files (`live/<pid>.json`: pid, time, projects with the sandbox on; `writeLive`, `readLive` drops dead or stale ones), `listSandboxes` (from `projects/*.json` and `homes/*`; `SandboxInfo`: exists, enabled, here/elsewhere/live, counts), `countSandboxes`. Used by the `sandboxes` and `removeSandbox` RPCs and the list view in the modal. | `paths.ts`, `state.ts` |
| `src/mcp.ts` | Wraps local MCP servers: `matchesName` (`*` globs), `sandboxServer` (backend `wrapArgv` around the server's argv, HOME = `state/mcp/<name>/<project hash>`, cwd = HOME, or the project with `mcpProjectWrite` (then the project is the writable folder, `protectHooks` is on and the lock still covers `.opencode` and `opencode.json(c)`), proxy env incl. `NODE_USE_ENV_PROXY=1`, `args` appended), `proxyEnv` (also used for shell commands). Network is `ask` through the project's proxy, or `closed` without a proxy port. | `backend.ts`, `paths.ts` |
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
   - Timeout: resolve `false` (the command's connection fails), **remove the
     ask** from `shared.asks`, `interrupt` the root session through the newest
     live copy, emit `changed` and `halted`. The next connection to that host
     asks again. (Keeping timed-out asks around once left a session refusing a
     host silently forever: nothing showed the old popup after a restart.)
     A settled ask still found in `shared.asks` is replaced, never reused.

Callers: the proxy (per runtime, via `latest().decide`), and the `webfetch`
permission hook (see below).

### webfetch

`webfetch` runs inside OpenCode, not in the shell, so it bypasses the
sandbox. `permission.hook("evaluate")` for `action === "webfetch"` parses the
URL from `resources`, runs `decide(root, host:port, "webfetch <url>")`, and on
a refusal sets `effect = "deny"` with a message starting `sandbox-mode`
(auto-mode leaves those denies alone). `websearch` is not covered. MCP servers
only through `sandboxMcp` (see MCP in the Backends section); remote ones can't
be wrapped and podman-based ones can't be contained.

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
  `/private/tmp`, `/private/var/folders`, the sandbox HOME,
  `/dev/*`.
- Protect hooks: deny writes to `.git/hooks`, `.git/config`, `.opencode`, `.envrc`.
- Config lock: `(deny file-write*)` on `lockedPaths` (config folders, state folder,
  project config files, `homeLinks` targets) after the project allow, then
  re-allow the sandbox HOME, which sits inside the state folder. Never stored:
  `lockConfig` is forced on at load and by `toggle`, and left out by `saveProject`.
  File tools are denied in a `permission` `evaluate` hook (`FILE_WRITE_ACTIONS`).
- MCP: `sandboxMcp` names go through `ctx.mcp.transform` (`src/mcp.ts`): `wrapArgv` puts the backend
  around the server's argv, HOME is `state/mcp/<name>/<project hash>`; cwd is the project with `mcpProjectWrite`. OpenCode runs MCP servers per location and the plugin
  has one copy per location, so each copy's transform wraps iff the sandbox is on for **its own** project
  (`project(fallbackDir())`); `toggle` calls `reloadMcp`, which reloads every live copy, so servers get the wrapped or
  original command. Fails closed: if the sandbox can't start, the server gets `disabled: true`. Remote servers and
  servers without a command are skipped.
  Network: one proxy per project (`shared.mcpProxies`, started in `setup`, stable port), `decideMcp(directory, target)`
  picks the owner session from `shared.calls` (tool calls in flight), else the project's latest runtime/session
  (`quiet`: no interrupt on timeout), then goes through `decide` like a shell command.
- Credentials: deny read and write on `credentialPaths`.
- Network out not open: deny outbound, allow unix sockets (DNS via
  mDNSResponder), `localhost:*` when the Localhost setting is on, and
  `localhost:<proxyPort>` in ask mode.
- Network in closed: deny `network-bind` and `network-inbound` on `*:*`.
- Paths go through `real()`: the profile must name `/private/var/...`.
- The profile is passed inline (`-p`), shell-quoted; no profile files.

### Linux: bubblewrap (`bwrapArgs`)

- Project-only writes: `--ro-bind / /`, `--tmpfs /tmp`, `--bind` project, HOME;
  otherwise `--bind / /`. Then `--dev`, `--proc`.
- Protected paths `--ro-bind` over themselves; credential dirs get `--tmpfs`,
  files `--ro-bind /dev/null`.
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
| Runtimes, asks, session map, running shell calls, tool calls in flight (`calls`), MCP proxies (`mcpProxies`, per project, stable port), failed/checked sessions, live copies | process memory | `globalThis.__opencodeSandboxMode` |
| Per-MCP-server `HOME` | server and project | `…/mcp/<name>/<hash>/` (wiped with the project) |
| Heartbeat of each OpenCode process | process | `…/live/<pid>.json`, refreshed every 20 s (`shared.heartbeat`), removed on exit; ignored when older than 90 s or the pid is dead |

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
  interrupt, decide, decideMcp, reloadMcp }`), registered at setup and removed on dispose. A stale
  closure once made "allow" in the popup do nothing.
- Read options through `shared.options ?? options` in long-lived paths.
- Restart OpenCode after larger changes; a running server keeps old shared
  objects (and old `asks`) across reloads.
- Every setup resets `lockConfig` to on for the projects already cached on `shared` (a hot reload keeps them), so the
  lock is back on after any plugin reload, also when the user just turned it off. A stale cached state once had no
  `lockConfig` at all (read as off). The same setup also runs `fillSettings`, and `project()` does it for any cached
  state with fewer keys than the defaults, so a setting added in a later version is its default, never `undefined`
  (the modal printed "undefined" and `adjust` treated it as an enum once).
- A copy only reloads the MCP servers of its own location: reloading after a toggle has to go through every entry in
  `shared.copies` (`reloadMcp`).

## TUI <-> server

- `state({ sessionID?, directory? })` returns everything the TUI renders:
  directory, `rootID`, settings, rows, lists (`project`, `global`, `config`),
  keybind, `failed`, `problem`, `backend`, `askSupported`, `linkedNetwork`,
  `files` (this project's home and whether anything is left on disk), `sandboxCount`, and the session's open asks.
- **RPC replies and event payloads must be plain JSON.** A field set to
  `undefined` fails the whole call with `rpc.invalid_output` (HTTP 500), and the
  TUI then silently does nothing (this broke the power button once). Every
  reply and emit goes through `json()`; keep it that way.
- Mutations return a fresh `state`; the server also emits `changed` and the TUI
  re-fetches every session state it holds.
- Popups follow the server. Every `ask` event only makes each window refresh
  the session on screen; `state.asks` (the server's filter: asks of that
  session's **root**, so a subagent view shows them too) drives `syncAsks`,
  which queues new asks (with an attention notify) and drops answered or
  timed-out ones, closing their popup. `showNextAsk` only shows asks whose
  session is on screen (`onScreen`: same ID or the cached `rootID`); others
  wait until you switch there. A window that has the ask's session in a tab
  (or, without tabs, the same project directory) but shows another session
  gets a toast with `sessionID`, which OpenCode turns into "open that
  session"; the route change refreshes and the popup follows. Several
  OpenCode windows share one server, so events reach all of them. `syncAsks`
  decisions go to `tui.log`.
- RPC events arrive as `{ type, data, … }` (`@opencode/client` `RpcEventPayload`);
  `listen()` unwraps `data`. Reading the envelope directly once broke every
  event-based check silently.
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
- The modal's dialog size follows the terminal: `xlarge` from `WIDE_MODAL_MIN_COLUMNS` (124) columns, else `large`,
  set in an effect on `useTerminalDimensions` inside `Modal` (so also on resize). `open()` doesn't set a size.
- Last rows: `removeFiles` (grey, "disabled", while the sandbox is on; `dialog.confirm`, then the modal is reopened) and
  `sandboxes` ("N entries ›"; opens a third view in the same component: `sbx` signal, `loadSandboxes`, keys `dd` wipe
  via confirm and `r` refresh, `h` back). The yellow legend lives in that view, not in the row description. After a
  confirm the modal reopens through `open(sessionID, undefined, row, sandboxEntry)`.
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

- Old flat `mcp/<name>/` folders (from before they were per project) aren't in the list; delete them by hand.
- Wiping a sandbox another OpenCode only has cached (off, not live) can be undone: that process writes its cached
  settings back on its next change. Only live sandboxes are refused.

- `websearch`, remote MCP servers and container-based (podman) MCP servers aren't covered.
- MCP network on Linux: no bridge for the per-project proxy yet, so wrapped servers get no network. Per-server
  allow lists (the popup doesn't name the server; the proxy can't tell them apart) are a possible next step via
  proxy credentials.
- MCP attribution to a session is a heuristic (`mcpOwner`: latest tool call in flight, else the project's latest
  runtime); two sessions calling servers at the same moment can swap.
- The user's `!` commands get no proxy in ask mode (no session to ask).
- `shellOwner` matches by time and cwd; two sessions in the same project
  starting shell calls at the same moment could swap runtimes (same project
  settings, only the one-off answers and popup target differ).
- macOS: unix sockets stay reachable (DNS, but also the podman/docker socket).
- `sandbox.log` grows without trimming.
- No `tsc` in the repo; type-check like auto-mode does (see its OUTLINE).
