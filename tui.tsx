/**
 * Sandbox mode TUI: a cube in the prompt footer, a settings modal with the
 * allow/block lists, and the "ask" popup for new network hosts.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { RGBA, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createRoot, createSignal, on as track } from "solid-js";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./src/paths.ts";
import type { ProjectSettings, SettingRow } from "./src/options.ts";
import { isValid } from "./src/patterns.ts";
import type { SandboxInfo } from "./src/sandboxes.ts";
import { SandboxMode } from "./src/rpc.ts";

interface Lists {
  allow: string[];
  deny: string[];
}

interface AskInfo {
  id: string;
  sessionID?: string;
  directory: string;
  target: string;
  command?: string;
  deadline: number;
  quiet?: boolean;
}

interface Payload {
  directory: string;
  rootID: string | null;
  enabled: boolean;
  settings: ProjectSettings;
  rows: SettingRow[];
  lists: { project: Lists; global: Lists; config: Lists };
  keybind: string;
  failed: boolean;
  problem: string | null;
  backend: string | null;
  askSupported: boolean;
  linkedNetwork: boolean;
  asks: AskInfo[];
  /** The sandbox home of this project and whether the sandbox left any files for it. */
  files?: { home: string; exists: boolean };
  sandboxCount?: number;
}

type ListView = { scope: "project" | "global"; kind: "allow" | "deny" };

const ICON = {
  cube: "\u{F01A7}",
  cubeOff: "\u{F141D}",
  power: "\uF011",
  globe: "\uF0AC",
  shield: "\uF132",
};
const MODAL_MARGIN = 2;
/** OpenCode's dialog adds one row of top padding around the plugin's content. */
const DIALOG_CHROME = 1;
const MODAL_MIN = 10;
const DOUBLE_TAP_MS = 600;

// Terminal palette slots, so Ghostty's Rosé Pine (or any theme) supplies the
// colours: 1 love, 2 pine, 3 gold, 4 foam, 5 iris, 8 muted. The hex values
// are only used when the terminal palette is unknown.
function ansi(index: number, fallback: string) {
  const from = (RGBA as any)?.fromIndex;
  if (typeof from === "function") {
    try {
      return from.call(RGBA, index, fallback);
    } catch {}
  }
  return fallback;
}
const COLOR = {
  love: ansi(1, "#eb6f92"),
  pine: ansi(2, "#31748f"),
  gold: ansi(3, "#f6c177"),
  foam: ansi(4, "#9ccfd8"),
  iris: ansi(5, "#c4a7e7"),
  muted: ansi(8, "#6e6a86"),
  surface: ansi(0, "#26233a"),
};

const VALUE_COLOR: Record<string, unknown> = {
  open: COLOR.gold,
  ask: COLOR.iris,
  closed: COLOR.foam,
};

const listKey = (row: SettingRow["key"]): ListView | undefined => {
  const match = /^list:(project|global):(allow|deny)$/.exec(row);
  return match ? { scope: match[1] as ListView["scope"], kind: match[2] as ListView["kind"] } : undefined;
};
const listTitle = (view: ListView) => `${view.scope === "project" ? "Project" : "Global"} ${view.kind === "allow" ? "allowlist" : "blocklist"}`;

/** The state folder as shown in settings, with the home folder as `~`. */
function stateFolderLabel(): string {
  const dir = stateDir();
  const home = homedir();
  return dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
}

/** Popup routing and RPC failures on the TUI side: ~/.local/state/opencode-sandbox-mode/tui.log. */
function tuiLog(event: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), "tui.log"), `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...data })}\n`);
  } catch {}
}

/** Opens the state folder in the OS file manager (Finder on macOS). */
function openStateFolder(): void {
  const dir = stateDir();
  try {
    mkdirSync(dir, { recursive: true });
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [dir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {}
}

export default Plugin.define({
  id: "sandbox-mode.tui",
  async setup(context) {
    const [store, update] = context.storage.memory("sandbox-mode", {
      initial: { states: {} as Record<string, Payload>, keybind: "<leader>o", asks: [] as AskInfo[], now: Date.now() },
    });
    const rpc = () => context.client.rpc(SandboxMode) as any;
    const currentSession = () => {
      const route = context.ui.router.current();
      return route?.type === "session" ? route.sessionID : undefined;
    };
    const key = (sessionID: string | undefined) => sessionID ?? "home";
    const directory = () => context.location?.directory ?? context.data.location.default()?.directory;

    /**
     * Popups follow the server: its `state` lists the open asks of the session's root (so subagent sessions show their
     * root's asks too). New ones are queued and announced; answered or timed-out ones disappear.
     */
    const syncAsks = (payload: Payload) => {
      const open = payload.asks ?? [];
      const fresh = open.filter((ask) => !store.asks.some((entry) => entry.id === ask.id));
      const gone = store.asks.filter((entry) => entry.sessionID === payload.rootID && !open.some((ask) => ask.id === entry.id));
      if (fresh.length === 0 && gone.length === 0) return;
      tuiLog("asks", { rootID: payload.rootID, fresh: fresh.map((ask) => ask.id), gone: gone.map((ask) => ask.id) });
      update((draft) => {
        draft.asks = draft.asks.filter((entry) => !gone.some((ask) => ask.id === entry.id));
        draft.asks.push(...fresh);
      });
      if (askOpen && gone.some((ask) => ask.id === askOpen)) {
        askOpen = undefined;
        context.ui.dialog.clear();
      }
      for (const ask of fresh) {
        void context.attention.notify({
          title: "Sandbox",
          message: `Allow a connection to ${ask.target}?`,
          notification: { when: "blurred" },
          sound: { name: "permission", when: "always" },
        });
      }
      showNextAsk();
    };

    const store_ = (sessionID: string | undefined, payload: any) => {
      if (!payload || typeof payload !== "object" || !payload.settings) return;
      update((draft) => {
        draft.states[key(sessionID)] = payload as Payload;
        if (typeof payload.keybind === "string") draft.keybind = payload.keybind;
      });
      if (sessionID && sessionID === currentSession()) syncAsks(payload as Payload);
    };
    const refresh = async (sessionID: string | undefined) => {
      try {
        store_(sessionID, await rpc().state({ sessionID, directory: directory() }));
      } catch (error) {
        // The server registers its RPC a moment after the TUI starts; the next `changed` event retries.
        if ((error as any)?.type !== "rpc.unavailable") console.error("[sandbox-mode] refresh", error);
      }
    };
    const call = async (method: string, sessionID: string | undefined, input: Record<string, unknown>) => {
      try {
        store_(sessionID, await rpc()[method]({ sessionID, directory: directory(), ...input }));
      } catch (error) {
        console.error(`[sandbox-mode] ${method}`, error);
      }
    };

    // ------------------------------------------------------------------ ask popup

    let askOpen: string | undefined;
    const showNextAsk = () => {
      if (askOpen) return;
      // Only asks for the session on screen; others wait until you switch to it.
      const next = store.asks.find((ask) => onScreen(ask.sessionID));
      if (!next) return;
      askOpen = next.id;
      context.ui.dialog.show(
        () => <AskPopup ask={next} />,
        () => {
          if (askOpen === next.id) askOpen = undefined;
        },
      );
      context.ui.dialog.set({ size: "medium", centered: true });
    };
    const answer = async (ask: AskInfo, choice: string) => {
      // Close first: a slow or failed call must not leave the popup looking unanswered.
      update((draft) => void (draft.asks = draft.asks.filter((entry) => entry.id !== ask.id)));
      askOpen = undefined;
      context.ui.dialog.clear();
      try {
        const reply = await Promise.race([
          rpc().answer({ id: ask.id, choice }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("no reply from the server in 5s")), 5000)),
        ]);
        if (!(reply as any)?.ok) {
          context.ui.toast.show({ variant: "warning", title: "Sandbox", message: `The request for ${ask.target} was already answered or expired.` });
        }
      } catch (error) {
        context.ui.toast.show({ variant: "error", title: "Sandbox", message: `Couldn't send your answer for ${ask.target}: ${(error as Error)?.message ?? error}` });
      }
      showNextAsk();
    };

    const AskPopup = (props: { ask: AskInfo }) => {
      const ctx = usePlugin();
      const live = () => store.asks.find((entry) => entry.id === props.ask.id) ?? props.ask;
      const left = () => Math.max(0, Math.ceil((live().deadline - store.now) / 1000));
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 20,
        commands: [
          { bind: "a", run: () => void answer(props.ask, "allow") },
          { bind: "w", run: () => void answer(props.ask, "whitelist") },
          { bind: "r", run: () => void answer(props.ask, "reject") },
          { bind: "b", run: () => void answer(props.ask, "blacklist") },
        ],
      }));
      const Choice = (p: { label: string; choice: string; color: unknown }) => (
        <text fg={p.color as any} attributes={TextAttributes.BOLD} onMouseUp={() => void answer(props.ask, p.choice)}>
          {p.label}
        </text>
      );
      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box flexDirection="row" gap={1}>
            <text fg={COLOR.iris as any}>{ICON.cube}</text>
            <text fg={COLOR.iris as any} attributes={TextAttributes.BOLD}>Sandbox: connect to a new host?</text>
          </box>
          <box height={1} />
          <text fg={ctx.theme.text.base as any} attributes={TextAttributes.BOLD}>{live().target}</text>
          {live().command && <text fg={COLOR.muted as any} wrapMode="word">{`probably from: ${live().command}`}</text>}
          <text fg={COLOR.muted as any}>{live().directory}</text>
          <box height={1} />
          <text fg={(left() <= 5 ? COLOR.love : COLOR.gold) as any}>{`${left()}s left, then the connection is refused${live().quiet ? "" : " and the agent stops"}`}</text>
          <box height={1} />
          <box flexDirection="row" gap={2}>
            <Choice label="(a)llow" choice="allow" color={COLOR.foam} />
            <Choice label="(w)hite-list" choice="whitelist" color={COLOR.pine} />
            <Choice label="(r)eject" choice="reject" color={COLOR.gold} />
            <Choice label="(b)lack-list" choice="blacklist" color={COLOR.love} />
          </box>
          <text fg={COLOR.muted as any} wrapMode="word">
            allow / reject: for this session · white-list / black-list: saved for this project
          </text>
        </box>
      );
    };

    // ------------------------------------------------------------------ modal

    /** `sandboxEntry` opens the list of all sandboxes with that entry selected (`selected` stays the settings row). */
    const open = (sessionID: string | undefined, view?: ListView, selected = 0, sandboxEntry?: number) => {
      void refresh(sessionID);
      context.ui.dialog.show(() => <Modal sessionID={sessionID} view={view} selected={selected} sandboxEntry={sandboxEntry} />);
      context.ui.dialog.set({ size: "large", centered: true });
    };

    const Modal = (props: { sessionID: string | undefined; view?: ListView; selected: number; sandboxEntry?: number }) => {
      const ctx = usePlugin();
      const dims = useTerminalDimensions();
      const height = () => Math.max(MODAL_MIN, Math.min(26, dims().height - 2 * MODAL_MARGIN - DIALOG_CHROME));
      const state = () => store.states[key(props.sessionID)];
      const [view, setView] = createSignal<ListView | undefined>(props.view);
      const [row, setRow] = createSignal(props.view ? 0 : props.selected);
      const [entry, setEntry] = createSignal(props.view ? props.selected : props.sandboxEntry ?? 0);
      const [sbx, setSbx] = createSignal<SandboxInfo[] | undefined>(props.sandboxEntry !== undefined ? [] : undefined);
      const inSandboxes = () => sbx() !== undefined;
      const [help, setHelp] = createSignal(false);
      let scroll: { scrollTo(position: number): void } | undefined;
      let pendingD = 0;
      let pendingG = 0;

      const entries = () => {
        const v = view();
        const s = state();
        return v && s ? s.lists[v.scope][v.kind] : [];
      };
      const configEntries = () => {
        const v = view();
        return v?.scope === "global" ? state()?.lists.config[v.kind] ?? [] : [];
      };
      const length = () => (inSandboxes() ? sbx()!.length : view() ? entries().length : state()?.rows.length ?? 0);
      const move = (delta: number) => {
        const max = Math.max(0, length() - 1);
        const next = Math.max(0, Math.min(max, (view() || inSandboxes() ? entry() : row()) + delta));
        if (view() || inSandboxes()) setEntry(next);
        else setRow(next);
        // Sandbox entries are two lines tall.
        scroll?.scrollTo(Math.max(0, inSandboxes() ? next * 2 - 4 : next - 5));
      };
      const loadSandboxes = async () => {
        try {
          const reply = await rpc().sandboxes({ sessionID: props.sessionID, directory: directory() });
          setSbx(Array.isArray(reply?.sandboxes) ? reply.sandboxes : []);
          setEntry((now) => Math.max(0, Math.min(now, (reply?.sandboxes?.length ?? 1) - 1)));
        } catch (error) {
          context.ui.toast.show({ variant: "error", title: "Sandbox", message: `Couldn't list the sandboxes: ${(error as Error)?.message ?? error}` });
        }
      };
      if (props.sandboxEntry !== undefined) void loadSandboxes();
      const change = (step: -1 | 1) => {
        const setting = state()?.rows[row()];
        if (!setting) return;
        if (setting.key === "openState") return step === 1 ? openStateFolder() : undefined;
        if (setting.key === "removeFiles") return step === 1 ? void removeFiles() : undefined;
        if (setting.key === "sandboxes") {
          if (step !== 1) return;
          setSbx([]);
          setEntry(0);
          scroll?.scrollTo(0);
          return void loadSandboxes();
        }
        const list = listKey(setting.key);
        if (list) return step === 1 ? openList(list) : undefined;
        void call("setSetting", props.sessionID, { key: setting.key, step });
      };
      const openList = (list: ListView) => {
        setView(list);
        setEntry(0);
        scroll?.scrollTo(0);
      };
      const back = () => {
        if (inSandboxes()) {
          setSbx(undefined);
          scroll?.scrollTo(Math.max(0, row() - 5));
          return;
        }
        setView(undefined);
        scroll?.scrollTo(Math.max(0, row() - 5));
      };
      const toggle = () => void call("toggle", props.sessionID, {});

      /** Wipes a sandbox from the list: any project, also ones whose folder is gone. The server refuses live ones. */
      const wipe = async () => {
        const item = sbx()?.[entry()];
        if (!item) return;
        if (item.live) {
          context.ui.toast.show({
            variant: "warning",
            title: "Sandbox",
            message: item.here ? "The sandbox is on for this project. Turn it off first." : "The sandbox is on in another OpenCode. Turn it off there first.",
          });
          return;
        }
        const target = item.directory ?? `(unknown project) ${item.hash}`;
        const confirmed = await context.ui.dialog.confirm({
          title: "Wipe this sandbox?",
          message: [
            target,
            item.directory && !item.exists ? "The project folder no longer exists." : "",
            "",
            `This deletes its sandbox home folder and its saved settings and allow/block lists (${item.allow} allow, ${item.deny} block).`,
            "",
            item.exists
              ? "Cancel first if you want to keep white-listed or black-listed hosts: open that project and move them to the global lists (press p in its list)."
              : "The white-listed and black-listed hosts of this project are lost with it.",
            "",
            "The project itself is not touched. This can't be undone.",
          ].join("\n"),
          label: { confirm: "Wipe", cancel: "Cancel" },
        });
        let selected = entry();
        if (confirmed) {
          try {
            const reply = await rpc().removeSandbox({ sessionID: props.sessionID, directory: directory(), hash: item.hash });
            if (Array.isArray(reply?.sandboxes)) selected = Math.min(selected, Math.max(0, reply.sandboxes.length - 1));
            context.ui.toast.show(
              reply?.removed
                ? { variant: "success", title: "Sandbox", message: "Wiped the sandbox." }
                : { variant: "warning", title: "Sandbox", message: String(reply?.reason ?? "Nothing was removed.") },
            );
          } catch (error) {
            context.ui.toast.show({ variant: "error", title: "Sandbox", message: `Couldn't wipe it: ${(error as Error)?.message ?? error}` });
          }
        }
        open(props.sessionID, undefined, row(), selected);
      };

      const removeFiles = async () => {
        const current = state();
        if (!current || current.enabled) return;
        if (!current.files?.exists) {
          context.ui.toast.show({ variant: "info", title: "Sandbox", message: "The sandbox left no files for this project." });
          return;
        }
        const allow = current.lists.project.allow.length;
        const deny = current.lists.project.deny.length;
        const confirmed = await context.ui.dialog.confirm({
          title: "Remove sandbox files for this project?",
          message: [
            current.directory,
            "",
            `This deletes the sandbox home folder (${current.files.home}) and this project's saved settings and allow/block lists (${allow} allow, ${deny} block).`,
            "",
            "Cancel first if you want to keep any white-listed or black-listed hosts: move them to the global lists (open the project list and press p).",
            "",
            "The project itself is not touched. This can't be undone.",
          ].join("\n"),
          label: { confirm: "Remove", cancel: "Cancel" },
        });
        if (confirmed) {
          try {
            const reply = await rpc().removeFiles({ sessionID: props.sessionID, directory: directory() });
            store_(props.sessionID, reply);
            context.ui.toast.show(
              reply?.removed
                ? { variant: "success", title: "Sandbox", message: "Removed the sandbox files for this project." }
                : { variant: "warning", title: "Sandbox", message: String(reply?.reason ?? "Nothing was removed.") },
            );
          } catch (error) {
            context.ui.toast.show({ variant: "error", title: "Sandbox", message: `Couldn't remove the files: ${(error as Error)?.message ?? error}` });
          }
        }
        open(props.sessionID, undefined, row());
      };

      const promptPattern = async (title: string, value: string) => {
        const list = view()!;
        const index = entry();
        const result = await context.ui.dialog.prompt({
          title,
          description: "A regex tested against host:port, for example ^registry\\.npmjs\\.org:443$ or \\.example\\.com:443$",
          placeholder: "^www\\.example\\.com:443$",
          value,
        });
        const pattern = result?.trim();
        if (pattern && !isValid(pattern)) {
          context.ui.toast.show({ variant: "error", title: "Sandbox", message: `Not a valid regex: ${pattern}` });
        }
        return { list, index, pattern: pattern && isValid(pattern) ? pattern : undefined };
      };
      const add = async () => {
        const { list, pattern } = await promptPattern(`Add to ${listTitle(view()!).toLowerCase()}`, "^");
        if (pattern) await call("listAdd", props.sessionID, { ...list, pattern });
        open(props.sessionID, list, pattern ? entries().length : 0);
      };
      const edit = async () => {
        const current = entries()[entry()];
        if (current === undefined) return;
        const { list, index, pattern } = await promptPattern("Edit entry", current);
        if (pattern) await call("listEdit", props.sessionID, { ...list, index, pattern });
        open(props.sessionID, list, index);
      };
      const remove = () => {
        if (inSandboxes()) return void wipe();
        const list = view();
        if (!list || entries()[entry()] === undefined) return;
        void call("listRemove", props.sessionID, { ...list, index: entry() }).then(() => move(0));
      };
      const promote = () => {
        const list = view();
        if (list?.scope !== "project" || entries()[entry()] === undefined) return false;
        void call("listPromote", props.sessionID, { kind: list.kind, index: entry() }).then(() => move(0));
      };

      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          { bind: "j", run: () => move(1) },
          { bind: "k", run: () => move(-1) },
          { bind: "down", run: () => move(1) },
          { bind: "up", run: () => move(-1) },
          {
            bind: "g",
            run: () => {
              const now = Date.now();
              if (now - pendingG < DOUBLE_TAP_MS) move(-100000);
              pendingG = now;
            },
          },
          {
            bind: "?",
            run: () => {
              setHelp((on) => !on);
            },
          },
          { bind: "shift+g", run: () => move(100000) },
          { bind: "home", run: () => move(-100000) },
          { bind: "end", run: () => move(100000) },
          { bind: "h", run: () => (view() || inSandboxes() ? back() : change(-1)) },
          { bind: "left", run: () => (view() || inSandboxes() ? back() : change(-1)) },
          { bind: "l", run: () => (view() || inSandboxes() ? false : change(1)) },
          { bind: "right", run: () => (view() || inSandboxes() ? false : change(1)) },
          { bind: "space", run: () => (view() || inSandboxes() ? false : change(1)) },
          { bind: "return", run: () => (view() ? void edit() : inSandboxes() ? false : change(1)) },
          { bind: "e", run: () => (view() ? void edit() : false) },
          { bind: "r", run: () => (inSandboxes() ? void loadSandboxes() : false) },
          { bind: "a", run: () => (view() ? void add() : false) },
          { bind: "p", run: () => (view() ? promote() : false) },
          {
            bind: "d",
            run: () => {
              if (!view() && !inSandboxes()) return false;
              const now = Date.now();
              if (now - pendingD < DOUBLE_TAP_MS) {
                pendingD = 0;
                remove();
              } else pendingD = now;
            },
          },
          { bind: "-", run: toggle },
        ],
      }));

      const linked = () => state()?.linkedNetwork ?? false;
      const on = () => state()?.enabled ?? false;
      const valueText = (setting: SettingRow) => {
        if (setting.key === "openState") return stateFolderLabel();
        if (setting.key === "removeFiles") return on() ? "disabled" : state()?.files?.exists ? "›" : "nothing to remove";
        if (setting.key === "sandboxes") return `${state()?.sandboxCount ?? 0} ›`;
        const list = listKey(setting.key);
        if (list) {
          const count = state()?.lists[list.scope][list.kind].length ?? 0;
          const extra = list.scope === "global" ? state()?.lists.config[list.kind].length ?? 0 : 0;
          return `${count} ${count === 1 ? "entry" : "entries"}${extra ? ` + ${extra} from config` : ""} ›`;
        }
        const value = state()?.settings[setting.key as keyof ProjectSettings];
        if (setting.key === "networkOut" && value === "ask" && state() && !state()!.askSupported) {
          return "ask (needs python3 or node; acts as closed)";
        }
        if (setting.key === "localhost" && linked()) return "n/a on Linux";
        return typeof value === "boolean" ? (value ? "on" : "off") : String(value);
      };
      const valueColor = (setting: SettingRow) => {
        if (setting.key === "removeFiles") return !on() && state()?.files?.exists ? COLOR.love : COLOR.muted;
        if (setting.key === "openState" || setting.key === "sandboxes" || listKey(setting.key)) return COLOR.iris;
        if (setting.key === "localhost" && linked()) return COLOR.muted;
        const value = state()?.settings[setting.key as keyof ProjectSettings];
        if (typeof value === "boolean") return value ? COLOR.foam : COLOR.muted;
        return VALUE_COLOR[String(value)] ?? COLOR.gold;
      };

      // The label column fits the longest label shown (the remove row only exists while the sandbox is off).
      const labelWidth = () => Math.max(20, ...(state()?.rows ?? []).map((setting) => setting.label.length + 1));
      const description = () => {
        const setting = state()?.rows[row()];
        if (setting?.key === "removeFiles" && on()) return "This option is disabled while the sandbox is enabled";
        return setting?.description ?? "";
      };
      const Settings = () => (
        <scrollbox ref={(el: any) => (scroll = el)} flexGrow={1} flexBasis={0} minHeight={0}>
          {(state()?.rows ?? []).map((setting, index) => (
            <box
              flexDirection="row"
              flexShrink={0}
              gap={1}
              backgroundColor={index === row() ? (COLOR.surface as any) : undefined}
              onMouseUp={() => {
                setRow(index);
                change(1);
              }}
            >
              <text
                fg={(setting.key === "removeFiles" ? (on() ? COLOR.muted : COLOR.love) : listKey(setting.key) || setting.key === "openState" || setting.key === "sandboxes" ? COLOR.iris : ctx.theme.text.base) as any}
                width={labelWidth()}
              >
                {setting.label}
              </text>
              <text fg={(on() || setting.key === "removeFiles" || setting.key === "sandboxes" ? valueColor(setting) : COLOR.muted) as any} attributes={TextAttributes.BOLD}>
                {valueText(setting)}
              </text>
            </box>
          ))}
          <box height={1} flexShrink={0} />
          <text fg={COLOR.muted as any} wrapMode="word">{description()}</text>
          <box height={1} flexShrink={0} />
          {linked() && (
            <text fg={COLOR.muted as any} wrapMode="word">
              On Linux, network in and out change together: the sandbox gets its own network, which either lets traffic through both
              ways (open) or not at all (ask, closed). Localhost is the sandbox's own, not this machine's.
            </text>
          )}
          {state()?.problem && on() && <text fg={COLOR.love as any} wrapMode="word">{`Sandbox can't start: ${state()!.problem}`}</text>}
          <text fg={COLOR.muted as any}>Settings are remembered for this project.</text>
        </scrollbox>
      );

      const List = () => (
        <scrollbox ref={(el: any) => (scroll = el)} flexGrow={1} flexBasis={0} minHeight={0}>
          {entries().map((pattern, index) => (
            <box
              flexDirection="row"
              flexShrink={0}
              gap={1}
              backgroundColor={index === entry() ? (COLOR.surface as any) : undefined}
              onMouseUp={() => setEntry(index)}
            >
              <text fg={(view()!.kind === "allow" ? COLOR.foam : COLOR.love) as any}>{view()!.kind === "allow" ? "✓" : "✗"}</text>
              <text fg={ctx.theme.text.base as any}>{pattern}</text>
            </box>
          ))}
          {entries().length === 0 && <text fg={COLOR.muted as any}>No entries. Press a to add one.</text>}
          {configEntries().length > 0 && (
            <>
              <box height={1} flexShrink={0} />
              <text fg={COLOR.muted as any}>From opencode.jsonc (edit them there):</text>
              {configEntries().map((pattern) => (
                <text fg={COLOR.muted as any}>{`  ${pattern}`}</text>
              ))}
            </>
          )}
        </scrollbox>
      );

      const statusOf = (item: SandboxInfo) => {
        const state = item.here ? "on in this OpenCode" : item.elsewhere ? "on in another OpenCode" : item.enabled ? "on, but no OpenCode is running it" : "off";
        const parts = [state];
        if (item.directory && !item.exists) parts.push("project folder is gone");
        if (!item.directory) parts.push("only a leftover home folder");
        if (item.current) parts.push("this project");
        parts.push(`${item.allow} allow, ${item.deny} block`);
        return parts.join(" · ");
      };
      const Sandboxes = () => (
        <scrollbox ref={(el: any) => (scroll = el)} flexGrow={1} flexBasis={0} minHeight={0}>
          {(sbx() ?? []).map((item, index) => (
            <box
              flexDirection="column"
              flexShrink={0}
              backgroundColor={index === entry() ? (COLOR.surface as any) : undefined}
              onMouseUp={() => setEntry(index)}
            >
              <box flexDirection="row" gap={1}>
                <text fg={(item.here ? COLOR.foam : item.elsewhere ? COLOR.iris : COLOR.muted) as any}>●</text>
                <text fg={(!item.directory || !item.exists ? COLOR.gold : ctx.theme.text.base) as any}>
                  {item.directory ?? `(unknown project) ${item.hash}`}
                </text>
              </box>
              <text fg={COLOR.muted as any}>{`  ${statusOf(item)}`}</text>
            </box>
          ))}
          {(sbx() ?? []).length === 0 && <text fg={COLOR.muted as any}>No sandboxes yet.</text>}
          <box height={1} flexShrink={0} />
          <text fg={COLOR.muted as any} wrapMode="word">
            {(() => {
              const item = sbx()?.[entry()];
              if (!item) return "";
              if (item.live) return "In use. Turn its sandbox off (in that OpenCode) before wiping it.";
              return "Press dd to wipe it: deletes its sandbox home folder and its saved settings and allow/block lists. The project itself is not touched.";
            })()}
          </text>
          <text fg={COLOR.muted as any}>Yellow: the project folder no longer exists.</text>
        </scrollbox>
      );

      const hint = () => {
        if (inSandboxes()) return help() ? "j/k move · gg/G top/bottom · dd wipe an inactive sandbox · r refresh · h back · esc close" : "j/k · dd wipe · r refresh · h back · ? help";
        if (help()) {
          return view()
            ? "j/k move · gg/G top/bottom · e/enter edit · a add · dd remove · p promote to global (project lists) · h back · esc close"
            : "j/k move · gg/G top/bottom · h/l change · space/enter change or open list · - power · esc close";
        }
        return view() ? "j/k · e edit · a add · dd remove · h back · ? help" : "j/k · h/l change · enter open · - power · ? help";
      };

      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} height={height()}>
          <box flexDirection="row" flexShrink={0} gap={1}>
            <text fg={(state()?.failed ? COLOR.love : on() ? COLOR.foam : COLOR.muted) as any} attributes={TextAttributes.BOLD}>
              {`${on() ? ICON.cube : ICON.cubeOff} Sandbox${view() ? ` · ${listTitle(view()!)}` : inSandboxes() ? " · All sandboxes" : ""}`}
            </text>
            <text fg={COLOR.muted as any}>{state()?.directory ?? ""}</text>
          </box>
          <box height={1} flexShrink={0} border={["top"]} borderColor={COLOR.muted as any} />
          {view() ? <List /> : inSandboxes() ? <Sandboxes /> : <Settings />}
          <box height={1} flexShrink={0} border={["top"]} borderColor={COLOR.muted as any} marginTop={1} />
          <box flexDirection="row" flexShrink={0} justifyContent="space-between">
            <text fg={COLOR.muted as any} wrapMode="word" flexShrink={1}>{hint()}</text>
            <text fg={(state()?.failed ? COLOR.love : on() ? COLOR.foam : COLOR.muted) as any} flexShrink={0} onMouseUp={toggle}>
              {`${ICON.power} ${on() ? "ON" : "OFF"} (-)`}
            </text>
          </box>
        </box>
      );
    };

    // ------------------------------------------------------------------ footer

    const FooterIcon = (props: { sessionID?: string }) => {
      const state = () => store.states[key(props.sessionID)];
      createEffect(track(() => props.sessionID, (id) => void refresh(id)));
      const color = () => (!state()?.enabled ? COLOR.muted : state()?.failed ? COLOR.love : COLOR.foam);
      return (
        <box flexDirection="row" flexShrink={0} onMouseUp={() => open(props.sessionID)}>
          <text fg={color() as any}>{state()?.enabled ? ICON.cube : ICON.cubeOff}</text>
        </box>
      );
    };

    const stopFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const route = context.ui.router.current();
        if (route?.type === "session") return <FooterIcon sessionID={route.sessionID} />;
        return route?.type === "home" ? <FooterIcon /> : null;
      },
    });

    // ------------------------------------------------------------------ events

    const unsubscribers: (() => void)[] = [];
    /** RPC events arrive as `{ type, data, … }`; handlers get `data`. */
    const listen = (event: string, handler: (payload: any) => void) => {
      try {
        unsubscribers.push(rpc().events.on(event, (envelope: any) => handler(envelope?.data ?? envelope)));
      } catch (error) {
        tuiLog("events.on failed", { event, error: String((error as Error)?.message ?? error) });
      }
    };
    listen("changed", () => {
      const ids = new Set([...Object.keys(store.states), key(currentSession())]);
      for (const id of ids) void refresh(id === "home" ? undefined : id);
    });
    /** Whether `sessionID` (a root session) is the one on screen, or the root of the subagent on screen. */
    const onScreen = (sessionID: string | undefined) => {
      const current = currentSession();
      return !!sessionID && !!current && (current === sessionID || store.states[key(current)]?.rootID === sessionID);
    };
    // The server decides which session an ask belongs to; refreshing the session on screen shows it (see syncAsks).
    // A window that has the session in a tab but shows something else gets a toast that opens it; the popup follows.
    listen("ask", (ask: AskInfo) => {
      void refresh(currentSession());
      if (!ask?.sessionID || onScreen(ask.sessionID)) return;
      const inTab = context.ui.tabs.enabled() && context.ui.tabs.list().some((tab) => tab.sessionID === ask.sessionID);
      if (!inTab && !(ask.directory && ask.directory === directory())) return;
      context.ui.toast.show({
        variant: "warning",
        message: `Sandbox: allow a connection to ${ask.target}?`,
        sessionID: ask.sessionID,
        duration: 15_000,
      });
    });
    listen("failed", (payload: any) => {
      if (!onScreen(payload?.sessionID)) return void refresh(currentSession());
      const message = `The sandbox can't start (${payload?.reason}). Commands run WITHOUT it in ${payload?.delaySeconds}s; press esc to stop.`;
      context.ui.toast.show({ variant: "error", title: "Sandbox", message, duration: 10_000, sessionID: payload?.sessionID });
      void context.attention.notify({ title: "Sandbox", message, sound: { name: "error" } });
      void refresh(currentSession());
    });
    listen("halted", (payload: any) => {
      if (!onScreen(payload?.sessionID)) return;
      const message = `No answer for ${payload?.target}: the connection was refused and the agent stopped. Prompt again to retry.`;
      context.ui.toast.show({ variant: "warning", title: "Sandbox", message, duration: 10_000 });
      void context.attention.notify({ title: "Sandbox", message, sound: { name: "error" } });
    });

    const ticker = setInterval(() => {
      if (store.asks.length > 0) update((draft) => void (draft.now = Date.now()));
    }, 500);

    void refresh(currentSession());

    // Closing a session tab releases its sandbox runtime (proxy, one-off answers). Without tabs, the server's idle sweep does it.
    let openTabs = new Set<string>();
    const stopTabs = createRoot((dispose) => {
      createEffect(() => {
        if (!context.ui.tabs.enabled()) return;
        const now = new Set(context.ui.tabs.list().map((tab) => tab.sessionID));
        for (const sessionID of openTabs) {
          if (!now.has(sessionID)) void rpc().release({ sessionID }).catch(() => {});
        }
        openTabs = now;
      });
      return dispose;
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "sandbox-mode.open",
          title: "Sandbox settings",
          group: "Sandbox",
          bind: store.keybind,
          palette: true,
          slash: { name: "sandbox" },
          run: () => open(currentSession()),
        },
      ],
      bindings: ["sandbox-mode.open"],
    }));

    return () => {
      clearInterval(ticker);
      stopTabs();
      for (const stop of unsubscribers) stop?.();
      stopFooter?.();
    };
  },
});
