# sandbox-mode

An OpenCode V2 plugin that runs the agent's shell commands in an OS sandbox:
Seatbelt (`sandbox-exec`) on macOS, bubblewrap on Linux. It's opt-in per
project. No containers, no images, no daemon.

Inspired by
[Hamza-Abili/opencode-sandbox](https://github.com/Hamza-Abili/opencode-sandbox).
The differences: every setting can be changed per project from the TUI,
and outgoing network can be **ask**, with a popup for each new host and
per-project and global allow/block lists.

## Requirements

- OpenCode V2
- macOS (Seatbelt ships with the OS), or Linux with
  [bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`).
  Ask mode on Linux also needs `python3` or `node` (see [Linux](#linux)).
- A Nerd Font in your terminal, for the icons
- Optional: the [auto-mode](https://github.com/HendrikPetertje/opencode-auto-mode)
  plugin, which supports sandbox-mode (see [Works with auto-mode](#works-with-auto-mode))

## Installation

```bash
cd ~/.config/opencode
git submodule add https://github.com/HendrikPetertje/opencode-sandbox-mode.git configured-plugins/sandbox-mode
# or, without submodules:
git clone https://github.com/HendrikPetertje/opencode-sandbox-mode.git configured-plugins/sandbox-mode
```

Don't put it in `plugins/`: OpenCode auto-loads every directory there
**without options**. There is no build step; OpenCode loads the TypeScript
directly. Run the tests with `bun test` in the plugin folder.

## Setup

```jsonc
"plugins": [
  {
    "package": "./configured-plugins/sandbox-mode",
    "options": {
      "networkOut": "ask"
    }
  }
]
```

Every option is optional. The settings options below are the **defaults for
projects you haven't opened yet**. Once a project exists, its settings are
whatever you last picked in the TUI.

## Using it

- A cube in the prompt footer shows the sandbox state for the current
  project:
  - cube outline in foam: the sandbox is on
  - crossed-out cube in grey: the sandbox is off
  - cube in red: the sandbox is on but couldn't start (see [When the sandbox can't start](#when-the-sandbox-cant-start))
- Click it, press `<leader>o`, or run `/sandbox` to open the settings.

### Settings modal

| Key | Action |
| --- | --- |
| `j` / `k` | move |
| `gg` / `G` | top / bottom |
| `h` / `l` | change the setting |
| `space` / `enter` | change the setting, or open a list |
| `-` | sandbox on / off (the power button, bottom right) |
| `?` | all shortcuts |
| `esc` | close |

The modal uses a wider dialog when the terminal is at least 124 columns wide.

### Allow and block lists

There are four lists: project allow, project block, global allow and global
block. Each entry is a regex tested against **`host:port`**, case-insensitive.
For example:

```
^registry\.npmjs\.org:443$
\.githubusercontent\.com:443$
^10\.1\.2\.3:5432$
```

The proxy only sees the host and port of an HTTPS connection, never the
`https://` or the path. That's why entries match `host:port` and not URLs.
Block lists win over allow lists. Project and global lists count the same.

In a list:

| Key | Action |
| --- | --- |
| `j` / `k` | move |
| `e` / `enter` | edit the entry |
| `a` | add an entry |
| `dd` | remove the entry |
| `p` | move a project entry to the matching global list |
| `h` | back to settings |

The `allow` and `deny` options in `opencode.jsonc` add to the global lists.
They show greyed out in the global list modals and can only be changed in the
config file.

### The ask popup

In **ask** mode, the first connection to a `host:port` that no list matches
opens a popup:

| Key | Meaning |
| --- | --- |
| `a` allow | allow this host for the rest of this session |
| `w` white-list | add `^host:port$` to the project allowlist |
| `r` reject | refuse this host for the rest of this session |
| `b` black-list | add `^host:port$` to the project blocklist |

The popup only shows in the OpenCode window that has the session open, also
while you're looking at one of its subagents. If you're on another session in
that window, you get a notification instead; clicking it opens the session and
the popup appears there.

Other connections to the same host wait for the same answer. If you don't
answer within `askTimeoutSeconds` (20 by default):

1. The connection is refused, so the command fails.
2. The agent is stopped.
3. You get a notification.

The popup closes, and the next connection to that host asks again. Prompt the
agent again to retry.

If a tool gives up on a connection faster than you can answer, add its host to
a list in advance with `a` in the list modal.

### One sandbox per session

Settings and lists are per project, but each session (with its subagents)
gets its own sandbox runtime: its own proxy and its own allow/reject answers.
The sandbox home folder is shared by all sessions of a project, so caches
survive.

A session's runtime is released when you close its tab. Runtimes of tabs
closed while OpenCode wasn't watching (a crash, quitting OpenCode) are released
after two hours without network use or shell commands.

Your own `!` shell commands aren't tied to a session, so in ask mode they get
no network (as if it were closed).

## What the sandbox does

Only the agent's `shell` tool runs in the sandbox. OpenCode's own file tools
(`read`, `edit`, `write`, …) run in OpenCode itself; see
[Files outside the project](#files-outside-the-project).

`webfetch` also runs in OpenCode itself, but its host goes through the same
network-out setting, lists and Ask popup as shell commands. With network out
on closed, it's denied. `websearch` isn't covered. MCP servers aren't either, unless you list them in
[`sandboxMcp`](#mcp-servers).

| Setting | Default | On |
| --- | --- | --- |
| Network out | `ask` | `open`: no limits. `ask`: only the plugin's proxy is reachable, and it asks per host. `closed`: no network, lists are ignored |
| Network in | `closed` | Commands can't listen on ports |
| Localhost | on | With network out on ask or closed, connections to this machine (dev servers, databases) still work (macOS only) |
| Project-only writes | on | Writes only inside the project, the temp folders and the sandbox home |
| Sandbox home | on | `HOME` is an empty per-project folder under `~/.local/state/opencode-sandbox-mode/homes/` |
| Protect hooks | on | `.git/hooks`, `.git/config`, `.opencode` and `.envrc` are read-only |
| Block credentials | on | `credentialPaths` can't be read or written |
| Remove sandbox files for this project | | The last row. Greyed out and disabled while the sandbox is on. When it is off, it deletes this project's sandbox home folder and its saved settings and allow/block lists, after a confirmation. See [Cleaning up](#cleaning-up) |
| List all sandboxes | | The very last row. Opens a list of every sandbox on this machine and lets you wipe the inactive ones. See [All sandboxes](#all-sandboxes) |
| MCP writes to project | off | Sandboxed MCP servers ([`sandboxMcp`](#mcp-servers)) of this project may write to the project folder and start in it. See [MCP servers](#mcp-servers) |
| Lock opencode config edits | on | The OpenCode config can't be changed, so a poisoned agent can't weaken or switch off the sandbox. See [Config lock](#config-lock) |

Commands in the sandbox see `OPENCODE_SANDBOX=seatbelt` (or `bubblewrap`).

### Cleaning up

Everything the sandbox makes lives in `~/.local/state/opencode-sandbox-mode/` and **stays after a reboot**: the sandbox
home of each project (`homes/<hash>/`), its saved settings and lists (`projects/<hash>.json`), the folders of
the folders of sandboxed MCP servers for a project (`mcp/<name>/<hash>/`), the global lists and the log. While the sandbox is off for a project, the last
row of the settings modal, **Remove sandbox files for this project**, deletes that project's home folder and its
saved settings and lists, after you confirm. (The row is greyed out while the sandbox is on.) The confirmation reminds
you that the project's allow and block lists go with it: move the entries you want to keep to the global lists first
(open the project list and press `p`). The project itself is not touched, and neither are the targets of
`homeLinks` (the symlinks in the home are removed, not followed). The next time you open the modal for the project it
starts from the defaults again. The MCP server folders of the project go with it. The global lists and the log are not
per project; delete them from the state folder by hand (**Open state folder** opens it), as well as the old
`mcp/<name>/` folders from before the folders were per project.

### All sandboxes

The last row of the settings modal, **List all sandboxes**, opens a list of every sandbox the plugin knows, also those of
projects you are not in. Each entry shows the project folder, whether the sandbox is on, and how many allow and block
entries it has:

- **on in this OpenCode** (blue dot) and **on in another OpenCode** (purple dot): in use.
- **on, but no OpenCode is running it**: the saved flag says on, but nothing is using it (OpenCode was closed or
  crashed).
- **off**.
- **Yellow**: the project folder no longer exists. A **leftover home folder** is a sandbox home whose settings file is
  gone; it is yellow too.

Sandboxes in use can't be wiped. For the others, `dd` wipes the sandbox after a confirmation: its home folder and its
saved settings and lists (and its MCP server folders), as with *Remove sandbox files for this project*, but from anywhere, so you can clean up after
a project was removed. `r` refreshes the list and `h` goes back. If you want to keep white-listed or black-listed
hosts of a project that still exists, move them to the global lists first.

How "in use" is known: every OpenCode process writes a small heartbeat file (`live/<pid>.json` in the state folder,
every 20 seconds) with the projects it has the sandbox on for. A project is in use when a fresh heartbeat of a
running process lists it. The saved on/off flag alone isn't enough: it stays on when OpenCode quits.

### Config lock

With **Lock opencode config edits** on, these are read-only for the agent:

- the OpenCode config folder (`~/.config/opencode`, or `$OPENCODE_CONFIG_DIR`), also when it is the project
- this plugin's state folder (it holds the on/off flag)
- the project's `opencode.json`, `opencode.jsonc` and `.opencode`
- the targets of `homeLinks`

Shell commands are blocked by the OS sandbox itself (a deny rule placed after
the project-write allow, so it holds inside the project and through `homeLinks`
symlinks; `--ro-bind` on Linux). OpenCode's `edit`, `write` and patch tools run
outside the sandbox, so the plugin denies them through the permission check.
The sandbox home inside the state folder stays writable.

The lock is never stored. It is on whenever the sandbox is turned on and after
every OpenCode start; switching it off in the settings modal is a deliberate
step each time. Add `service.json` (the server password, which can drive the
plugin's RPC) to `credentialPaths` so a shell command can't read it.

### MCP servers

MCP servers run outside the sandbox. This is opt-in: list local servers in
`sandboxMcp` and the plugin rewrites their `command` so they start inside it.

```jsonc
"sandboxMcp": [
  "my-server",
  "tools-*",
  { "name": "other", "args": ["--some-flag"] }
]
```

A name matches the server's name in your `mcp` config (case-insensitive, `*` matches anything). An object can also
carry `args`, which are added to the command only while it is sandboxed.

- **When:** per project. A project's servers are wrapped while the sandbox is on for that project. Turning it off puts
  the original command back, and the servers restart either way.
- **Files:** each server gets its own folder per project, `~/.local/state/opencode-sandbox-mode/mcp/<name>/<project hash>`,
  as `HOME` and working folder. It can write there and to the temp folders. It can read everything except your
  `credentialPaths`, the project included, by absolute path. `homeLinks`, `credentialPaths` and the config lock apply as
  for shell commands.
- **Project access:** the project's **MCP writes to project** setting (a row in the settings modal, off by default,
  per project) lets the servers of that project write to the project folder, and makes it their working folder, so
  relative paths work. This is meant for servers that belong to one project, for example ones declared in the
  project's own `opencode.json`. The project's `.git/hooks`, `.git/config`, `.envrc`, `.opencode` and
  `opencode.json(c)` stay read-only. Changing the setting restarts the project's servers.
- **Network:** the servers of a project go through that project's own proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
  and `NODE_USE_ENV_PROXY=1` so Node's own `fetch` uses it too). Direct connections, localhost included, and listening
  on ports are blocked, so a tool that ignores the proxy settings has no network. The network setting and the lists
  are the project's (plus the global ones) and work like for shell commands: the ask popup, the toast, the one-off
  allow and reject answers, and white-listing and black-listing into the project's lists.
- **Which session is asked:** a server is shared by all sessions of its project, so a connection is attributed to the
  session whose tool call is in flight (the latest one). The popup and the stop-the-agent timeout then work as for
  that session's shell commands. With no call in flight (a server starting up) the project's most recently used
  session gets the popup, but the agent is not stopped when you don't answer. With no session at all, only the lists
  decide. If two sessions of one project call servers at the same moment, the latest call gets the popup. Decisions
  are logged as `mcp.network` in `sandbox.log`.
- **Fails closed:** if the sandbox can't start, the server is disabled rather than run without it.
- **Not covered:** remote servers (nothing runs locally), servers started through a container runtime such as
  `podman run` (the container isn't inside the wrapper), and single tools: they run inside their server's process, so
  the sandbox is per server. On Linux there is no network bridge for this yet: servers get no network.
- **Programs with their own sandbox** (browsers) can't start it inside this one. Pass whatever disables it, and
  anything the empty `HOME` lacks, through `args`.

**Pre-white-list package registries.** A server started with `npx`, `uvx` or similar downloads its package on every
start, and that goes through the proxy. In ask mode the first start would open a popup (and with no session in use it
is refused), so allow the registry up front, in the project or global allow list or in the `allow` option:
`^registry\.npmjs\.org:443$` for npm (the registry host, not `api.npmjs.org`, which only serves download statistics),
or your company's registry if you use one. Python tools need `^pypi\.org:443$` and `^files\.pythonhosted\.org:443$`.
The servers' own hosts (an API, a website) are best allowed on first use through the popup.

### Linux

bubblewrap gives the sandbox its own network namespace instead of filtering
connections, which changes a few things:

- **Network in and out change together.** With network out on open, the
  sandbox shares the machine's network both ways. With ask or closed, it has
  no network, so nothing can connect in either. Changing one setting changes
  the other, and the modal explains this under the list.
- **Localhost is the sandbox's own.** Dev servers and databases on the
  machine aren't reachable with network out on ask or closed, so the
  Localhost setting doesn't apply.
- **Ask mode uses a bridge.** The proxy also listens on a unix socket that's
  mounted into the sandbox. A small forwarder inside the sandbox, run with
  `python3` or `node` (whichever the machine has), connects the proxy port
  to it. With neither installed, ask acts as closed and the modal says so.

### Files outside the project

The sandbox only contains shell commands. OpenCode's file tools (`read`,
`edit`, `write`, …) run outside it, so for those it depends on whether
auto-mode is loaded; see [Works with auto-mode](#works-with-auto-mode).
Without auto-mode, or with auto-mode off, OpenCode's own
`external_directory` rules apply unchanged.

## Works with auto-mode

[auto-mode](https://github.com/HendrikPetertje/opencode-auto-mode) supports
sandbox-mode. When both are loaded and the sandbox is on for a project:

- **File tools reaching outside the project always ask you.** auto-mode
  doesn't review them or allow them on its own.
- **Shell commands are still reviewed.** The reviewer is told the project is
  sandboxed, so it asks you about anything that reads or changes things
  outside the project. It only denies what it would deny anyway. MCP tools
  (memory, docs, …) are reviewed as usual.
- **Sandbox denies stand.** When the sandbox refuses a `webfetch` host,
  auto-mode doesn't override it.
- **Its log says why.** These decisions show up with the source `sandbox`
  in auto-mode's modal and log.

Nothing to configure: auto-mode picks this up as soon as both plugins are
loaded. With auto-mode turned off, OpenCode's own rules apply.

### When the sandbox can't start

At the first tool call of each session in a sandboxed project, the plugin
checks that `sandbox-exec` or `bwrap` works. If it doesn't:

1. You get a notification with the reason.
2. That first tool call waits `failDelaySeconds` (4 by default), so you can
   press `esc` to stop the agent.
3. After that, commands run **without** the sandbox for the rest of the
   session, and the cube turns red.

A new session checks again.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Sandbox on for new projects |
| `networkOut` | `"ask"` | `"open"`, `"ask"` or `"closed"` for new projects |
| `networkIn` | `"closed"` | `"open"` or `"closed"` for new projects |
| `localhost` | `true` | See Localhost above |
| `projectOnlyWrites` | `true` | |
| `syntheticHome` | `true` | |
| `protectHooks` | `true` | |
| `blockCredentials` | `true` | |
| `credentialPaths` | `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`, `~/.docker/config.json`, `~/.kube`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.local/share/opencode/auth.json` | Replaces the default list, so repeat the defaults you want to keep |
| `homeLinks` | `[]` | Paths in your real home (`~/...`) that are symlinked into the sandbox home at the same relative path, so tools still find their config there (e.g. `~/.npmrc`). Skipped if the path is missing, outside your home, or inside a credential path. |
| `sandboxMcp` | `[]` | Local MCP servers that only start inside the sandbox: a name (`*` matches anything, e.g. `my-server-*`) or `{ "name": "...", "args": ["..."] }`. The `args` are added to the command only while it is sandboxed. See [MCP servers](#mcp-servers) |
| `extends` | none | Path to a `.jsonc` file with more options. Relative paths are relative to the OpenCode config folder, `~` works. Keys in that file override the inline ones, and a missing file is ignored, so it can be git-ignored. A broken file is logged in `sandbox.log` |
| `allow` | `[]` | Global allowlist entries (regexes) |
| `deny` | `[]` | Global blocklist entries (regexes) |
| `askTimeoutSeconds` | `20` | How long the ask popup waits |
| `failDelaySeconds` | `4` | Pause before running unsandboxed |
| `keybind` | `"<leader>o"` | Opens the settings. You can also set `"sandbox-mode.open"` under `keybinds` in `cli.json` |

## Limits

- **Ask only covers proxy-aware tools.** The sandbox sets `HTTP(S)_PROXY`,
  `ALL_PROXY` (SOCKS5) and their lowercase forms. Tools that ignore them can't
  reach the network at all; nothing gets past without being checked.
- **Unix sockets stay open on macOS**, for DNS and local services. That
  includes the podman/docker socket, if your user can reach it.
- **Seatbelt is deprecated by Apple.** It still works and is what Chromium and
  Claude Code use. Some tools (browsers, podman) need extra paths or don't
  work in it.
- **Sandbox home:** git and other tools won't see your real dotfiles. Git
  needs `user.name`/`user.email` in the repo, turn the setting off, or share
  specific paths with `homeLinks`.
- **Without sandbox home**, `zsh -c` still reads `~/.zshenv`. If that file
  is inside a credential path, every command prints a permission error.
- **Only the agent's shell commands are sandboxed.** Your own `!` commands
  might be wrapped too (they go through the same hook). MCP servers only if you
  list them in `sandboxMcp`; OpenCode itself isn't.

## Files

**Open state folder** in the settings modal opens this folder in Finder (or
your file manager on Linux).

- `~/.local/state/opencode-sandbox-mode/projects/<hash>.json`: a project's
  settings and lists
- `~/.local/state/opencode-sandbox-mode/global.json`: the global lists
- `~/.local/state/opencode-sandbox-mode/homes/<hash>/`: sandbox homes
- `~/.local/state/opencode-sandbox-mode/run/<hash>/` (Linux): a session's
  proxy socket and forwarder, removed when the session's sandbox is released
- `~/.local/state/opencode-sandbox-mode/sandbox.log`: Ask popups, answers,
  timeouts and errors, for troubleshooting
- `~/.local/state/opencode-sandbox-mode/tui.log`: whether each OpenCode window
  showed a popup, for troubleshooting

## License

MIT
