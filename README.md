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
  [bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`)
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
| `1`–`9` | jump to a row and change it |
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

The popup only shows in the OpenCode window that has the session open (or one
of its subagents).

Other connections to the same host wait for the same answer. If you don't
answer within `askTimeoutSeconds` (20 by default):

1. The connection is refused, so the command fails.
2. The agent is stopped.
3. You get a notification.

The popup stays open, and your answer counts from then on. Answer it, then
prompt the agent again.

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
| Localhost | on | With network out on ask or closed, connections to this machine (dev servers, databases) still work |
| Project-only writes | on | Writes only inside the project, the temp folders, the sandbox home and `extraWritePaths` |
| Sandbox home | on | `HOME` is an empty per-project folder under `~/.local/state/opencode-sandbox-mode/homes/` |
| Protect hooks | on | `.git/hooks`, `.git/config`, `.opencode` and `.envrc` are read-only |
| Block credentials | on | `credentialPaths` can't be read or written |

Commands in the sandbox see `OPENCODE_SANDBOX=seatbelt` (or `bubblewrap`).

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
| `extraReadPaths` | `[]` | Readable even if inside a credential path |
| `extraWritePaths` | `[]` | Writable with project-only writes on |
| `allow` | `[]` | Global allowlist entries (regexes) |
| `deny` | `[]` | Global blocklist entries (regexes) |
| `askTimeoutSeconds` | `20` | How long the ask popup waits |
| `failDelaySeconds` | `4` | Pause before running unsandboxed |
| `keybind` | `"<leader>o"` | Opens the settings. You can also set `"sandbox-mode.open"` under `keybinds` in `cli.json` |

## Limits

- **Ask only covers proxy-aware tools.** The sandbox sets `HTTP(S)_PROXY`,
  `ALL_PROXY` (SOCKS5) and their lowercase forms. Tools that ignore them can't
  reach the network at all; nothing gets past without being checked.
- **Linux: ask acts as closed.** bubblewrap has no route to the host's
  proxy yet, so ask blocks all network for now. Also, network in can't be
  blocked while network out is open.
- **Unix sockets stay open**, for DNS and local services. That includes the
  podman/docker socket, if your user can reach it.
- **Seatbelt is deprecated by Apple.** It still works and is what Chromium and
  Claude Code use. Some tools (browsers, podman) need extra paths or don't
  work in it.
- **Sandbox home:** git and other tools won't see your real dotfiles. Git
  needs `user.name`/`user.email` in the repo, or turn the setting off.
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
- `~/.local/state/opencode-sandbox-mode/sandbox.log`: Ask popups, answers,
  timeouts and errors, for troubleshooting

## License

MIT
