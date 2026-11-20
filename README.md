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
on closed, it's denied. MCP servers and `websearch` aren't covered.

| Setting | Default | On |
| --- | --- | --- |
| Network out | `ask` | `open`: no limits. `ask`: only the plugin's proxy is reachable, and it asks per host. `closed`: no network, lists are ignored |
| Network in | `closed` | Commands can't listen on ports |
| Localhost | on | With network out on ask or closed, connections to this machine (dev servers, databases) still work (macOS only) |
| Project-only writes | on | Writes only inside the project, the temp folders and the sandbox home |
| Sandbox home | on | `HOME` is an empty per-project folder under `~/.local/state/opencode-sandbox-mode/homes/` |
| Protect hooks | on | `.git/hooks`, `.git/config`, `.opencode` and `.envrc` are read-only |
| Block credentials | on | `credentialPaths` can't be read or written |
| Lock opencode config edits | on | The OpenCode config can't be changed, so a poisoned agent can't weaken or switch off the sandbox. See [Config lock](#config-lock) |

Commands in the sandbox see `OPENCODE_SANDBOX=seatbelt` (or `bubblewrap`).

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
  might be wrapped too (they go through the same hook); MCP servers and
  OpenCode itself aren't.

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
