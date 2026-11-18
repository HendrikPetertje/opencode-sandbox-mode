/**
 * Sandbox mode: runs the agent's shell commands in an OS sandbox (Seatbelt on
 * macOS, bubblewrap on Linux), opt-in per project. Each session gets its own
 * sandbox runtime (network proxy, one-off answers), released when its tab
 * closes or after a while without use. See README.md.
 */
import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backendFor, type Backend, type Spec } from "./src/backend.ts";
import { adjust, parseOptions, SETTING_ROWS, type Options, type SettingKey } from "./src/options.ts";
import { expandHome, isInside, projectHash, stateDir } from "./src/paths.ts";
import { exact, isValid, judge } from "./src/patterns.ts";
import { startProxy, type Proxy } from "./src/proxy.ts";
import { SandboxMode } from "./src/rpc.ts";
import { loadGlobal, loadProject, saveGlobal, saveProject, type Lists, type ProjectState } from "./src/state.ts";

const LOOKUP_TIMEOUT_MS = 3_000;
/** A pending shell call and its create.before are matched within this window. */
const SHELL_MATCH_MS = 30_000;
const SWEEP_EVERY_MS = 10 * 60_000;
/** Runtimes without a shell call or network request for this long are released (tabs closed while the TUI was gone). */
const IDLE_RELEASE_MS = 2 * 60 * 60_000;
type Choice = "allow" | "whitelist" | "reject" | "blacklist";
const CHOICES: Choice[] = ["allow", "whitelist", "reject", "blacklist"];

interface Ask {
  id: string;
  /** Root session the sandbox runtime belongs to. */
  sessionID: string;
  directory: string;
  target: string;
  command?: string;
  deadline: number;
  timedOut: boolean;
  settled: boolean;
  resolve: (allowed: boolean) => void;
  promise: Promise<boolean>;
}

/** One per root session: its proxy and its (a)llow / (r)eject answers. */
interface Runtime {
  sessionID: string;
  directory: string;
  proxy?: Promise<Proxy>;
  once: Map<string, boolean>;
  lastUsed: number;
}

/** What a live copy of the plugin offers to long-lived pieces (proxies, timers) that outlive the copy that made them. */
interface Copy {
  emit: (event: string, payload: Record<string, unknown>) => void;
  interrupt: (sessionID: string) => Promise<unknown>;
  decide: (sessionID: string, target: string, command?: string) => Promise<boolean>;
}

interface Shared {
  options?: Options;
  backend?: Backend;
  /** Why the sandbox can't start on this machine; undefined when it works. Re-checked for every new session. */
  problem?: string;
  probed?: boolean;
  projects: Map<string, ProjectState>;
  global?: Lists;
  runtimes: Map<string, Runtime>;
  asks: Map<string, Ask>;
  /** Session -> its directory and root session. */
  sessions: Map<string, { directory: string; rootID: string }>;
  /** Shell calls in flight: call ID -> root session, project and command. */
  running: Map<string, { sessionID: string; directory: string; command?: string; at: number; matched: boolean }>;
  checked: Set<string>;
  failed: Set<string>;
  /** Live copies, newest last. The server runs one copy per location and a new one on every hot reload. */
  copies: Copy[];
  sweeper?: ReturnType<typeof setInterval>;
  /** Read by the auto-mode plugin. */
  isSandboxed: (directory: string | undefined) => boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** RPC replies and events must be plain JSON: `undefined` fields make the whole call fail. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const logError = (where: string, error?: unknown) => {
  console.error(`[sandbox-mode] ${where}`, error ?? "");
  log("error", { where, error: String((error as Error)?.message ?? error ?? "") });
};
/** Network decisions and errors, for troubleshooting: ~/.local/state/opencode-sandbox-mode/sandbox.log. */
function log(event: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), "sandbox.log"), `${JSON.stringify({ time: new Date().toISOString(), event, ...data })}\n`);
  } catch {}
}

export default Plugin.define({
  id: "sandbox-mode",
  async setup(ctx) {
    const options = parseOptions(ctx.options as Record<string, unknown>);
    // All mutable state lives on globalThis: hooks, the TUI's RPC calls and the proxies can each land in a different copy.
    const shared = ((globalThis as any).__opencodeSandboxMode ??= {}) as Shared;
    shared.projects ??= new Map();
    shared.runtimes ??= new Map();
    shared.asks ??= new Map();
    shared.sessions ??= new Map();
    shared.running ??= new Map();
    shared.checked ??= new Set();
    shared.failed ??= new Set();
    shared.copies ??= [];
    shared.options = options;
    shared.backend = backendFor(process.platform);
    const latest = () => shared.copies.at(-1);
    const emit = (event: string, payload: Record<string, unknown>) => latest()?.emit(event, payload);

    const project = (directory: string): ProjectState => {
      let state = shared.projects.get(directory);
      if (!state) {
        state = loadProject(directory, shared.options ?? options);
        shared.projects.set(directory, state);
      }
      return state;
    };
    const globalLists = (): Lists => (shared.global ??= loadGlobal());
    const save = (state: ProjectState) => {
      try {
        saveProject(state);
      } catch (error) {
        logError("saving project state", error);
      }
    };
    shared.isSandboxed = (directory) => (directory ? project(directory).settings.enabled : false);

    const probe = (): string | undefined => {
      shared.probed = true;
      shared.problem = shared.backend ? shared.backend.probe() : `no sandbox for ${process.platform}`;
      return shared.problem;
    };

    // ---------------------------------------------------------------- sessions

    const fallbackDir = () => ctx.location?.directory ?? process.cwd();
    /** A session's project directory and root session (subagents share their root's sandbox). */
    const sessionInfo = async (sessionID: string): Promise<{ directory: string; rootID: string }> => {
      const known = shared.sessions.get(sessionID);
      if (known) return known;
      try {
        const got = await withTimeout<any>(ctx.session.get({ sessionID } as any), LOOKUP_TIMEOUT_MS);
        const directory: string = got?.location?.directory ?? fallbackDir();
        const rootID = got?.parentID ? (await sessionInfo(got.parentID)).rootID : sessionID;
        const info = { directory, rootID };
        shared.sessions.set(sessionID, info);
        return info;
      } catch (error) {
        logError(`session lookup ${sessionID}`, error);
        return { directory: fallbackDir(), rootID: sessionID };
      }
    };
    const sessionDir = async (sessionID: string | undefined) => (sessionID ? (await sessionInfo(sessionID)).directory : fallbackDir());

    const runtime = (sessionID: string, directory: string): Runtime => {
      let entry = shared.runtimes.get(sessionID);
      if (!entry) {
        entry = { sessionID, directory, once: new Map(), lastUsed: Date.now() };
        shared.runtimes.set(sessionID, entry);
        log("runtime.start", { sessionID, directory });
      }
      entry.lastUsed = Date.now();
      return entry;
    };

    const release = async (sessionID: string, reason: string) => {
      const entry = shared.runtimes.get(sessionID);
      for (const [key, ask] of shared.asks) {
        if (ask.sessionID !== sessionID) continue;
        shared.asks.delete(key);
        ask.resolve(false);
      }
      if (!entry) return;
      shared.runtimes.delete(sessionID);
      log("runtime.release", { sessionID, reason });
      const proxy = await entry.proxy?.catch(() => undefined);
      await proxy?.close();
      emit("changed", {});
    };

    /**
     * create.before only knows the cwd and command. The shell call that started it was recorded by execute.before
     * just before: take the oldest unmatched one in a project around the cwd.
     */
    const shellOwner = (cwd: string): { sessionID?: string; directory: string } => {
      const now = Date.now();
      const candidates = [...shared.running.values()]
        .filter((call) => !call.matched && now - call.at < SHELL_MATCH_MS && isInside(cwd, call.directory))
        .sort((a, b) => a.at - b.at);
      const call = candidates[0];
      if (call) {
        call.matched = true;
        return { sessionID: call.sessionID, directory: call.directory };
      }
      // Not an agent shell call (your own `!` command, a terminal): the deepest known project around the cwd.
      const dirs = [...new Set([...shared.sessions.values()].map((info) => info.directory))];
      if (ctx.location?.directory) dirs.push(ctx.location.directory);
      const directory = dirs.filter((dir) => isInside(cwd, dir)).sort((a, b) => b.length - a.length)[0] ?? cwd;
      return { directory };
    };

    // ---------------------------------------------------------------- network

    const allLists = (directory: string): Lists => {
      const own = project(directory).lists;
      const global = globalLists();
      const config = shared.options ?? options;
      return { allow: [...own.allow, ...global.allow, ...config.allow], deny: [...own.deny, ...global.deny, ...config.deny] };
    };

    const askPayload = (ask: Ask) => ({
      id: ask.id,
      sessionID: ask.sessionID,
      directory: ask.directory,
      target: ask.target,
      command: ask.command,
      deadline: ask.deadline,
      timedOut: ask.timedOut,
    });

    /** Whether the root session `sessionID` may connect to `target` (`host:port`). */
    const decide = async (sessionID: string, target: string, command?: string): Promise<boolean> => {
      const entry = shared.runtimes.get(sessionID);
      const directory = entry?.directory ?? (await sessionDir(sessionID));
      const { settings } = project(directory);
      if (!settings.enabled || settings.networkOut === "open") return true;
      if (settings.networkOut === "closed") return false;
      const verdict = judge(target, allLists(directory));
      if (verdict !== "ask") return verdict === "allow";
      const own = runtime(sessionID, directory);
      const remembered = own.once.get(target);
      if (remembered !== undefined) return remembered;

      const key = `${sessionID}\u0000${target}`;
      const existing = shared.asks.get(key);
      if (existing) return existing.promise;

      let resolve!: (allowed: boolean) => void;
      const promise = new Promise<boolean>((done) => (resolve = done));
      const running = [...shared.running.values()].filter((call) => call.sessionID === sessionID).at(-1);
      const timeout = (shared.options ?? options).askTimeoutSeconds * 1000;
      const ask: Ask = {
        id: `${projectHash(directory)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        sessionID,
        directory,
        target,
        command: command ?? running?.command,
        deadline: Date.now() + timeout,
        timedOut: false,
        settled: false,
        resolve: (allowed) => {
          if (ask.settled) return;
          ask.settled = true;
          resolve(allowed);
        },
        promise,
      };
      shared.asks.set(key, ask);
      log("ask", { id: ask.id, sessionID, target, command: ask.command });
      emit("ask", askPayload(ask));
      setTimeout(() => {
        if (ask.settled) return;
        // The command fails and the agent stops; the popup stays so the answer still counts for next time.
        ask.timedOut = true;
        ask.resolve(false);
        log("timeout", { id: ask.id, sessionID, target });
        emit("changed", {});
        void latest()
          ?.interrupt(sessionID)
          .catch((error) => logError(`interrupt ${sessionID}`, error));
        emit("halted", { sessionID, directory, target });
      }, timeout);
      return promise;
    };

    /** Proxies outlive the copy that started them, so they decide through the newest live copy. */
    const proxyFor = (entry: Runtime): Promise<Proxy> => {
      if (!entry.proxy) {
        entry.proxy = startProxy(async (target) => {
          entry.lastUsed = Date.now();
          const copy = latest();
          return copy ? copy.decide(entry.sessionID, target) : false;
        });
        entry.proxy.catch(() => (entry.proxy = undefined));
      }
      return entry.proxy;
    };

    // ---------------------------------------------------------------- RPC

    const statePayload = async (input: { sessionID?: string; directory?: string }) => {
      const info = input.sessionID ? await sessionInfo(input.sessionID) : undefined;
      const directory = info?.directory ?? input.directory ?? fallbackDir();
      const state = project(directory);
      if (!shared.probed) probe();
      return json({
        directory,
        rootID: info?.rootID ?? null,
        enabled: state.settings.enabled,
        settings: state.settings,
        rows: SETTING_ROWS,
        lists: { project: state.lists, global: globalLists(), config: { allow: options.allow, deny: options.deny } },
        keybind: options.keybind,
        failed: info ? shared.failed.has(info.rootID) : false,
        problem: shared.problem ?? null,
        backend: shared.backend?.name ?? null,
        askSupported: shared.backend?.supportsAsk ?? false,
        asks: [...shared.asks.values()].filter((ask) => (info ? ask.sessionID === info.rootID : ask.directory === directory)).map(askPayload),
      });
    };

    type ListInput = { sessionID?: string; directory?: string; scope?: string; kind?: string; index?: number; pattern?: string };
    const listOf = async (input: ListInput) => {
      const directory = input.sessionID ? await sessionDir(input.sessionID) : input.directory ?? fallbackDir();
      const kind = input.kind === "deny" ? "deny" : "allow";
      const isGlobal = input.scope === "global";
      const state = project(directory);
      const lists = isGlobal ? globalLists() : state.lists;
      const persist = () => {
        try {
          if (isGlobal) saveGlobal(globalLists());
          else saveProject(state);
        } catch (error) {
          logError("saving lists", error);
        }
        emit("changed", {});
      };
      return { list: lists[kind], kind, state, persist };
    };
    const projectOf = async (input: any) => project(input?.sessionID ? await sessionDir(input.sessionID) : input?.directory ?? fallbackDir());

    const registration = await ctx.rpc.register(SandboxMode, {
      state: async (input: any) => statePayload(input ?? {}),
      toggle: async (input: any) => {
        const state = await projectOf(input);
        state.settings = { ...state.settings, enabled: !state.settings.enabled };
        save(state);
        emit("changed", {});
        return statePayload(input ?? {});
      },
      setSetting: async (input: any) => {
        const state = await projectOf(input);
        const key = input?.key as SettingKey;
        if (key in state.settings && key !== ("enabled" as string)) {
          state.settings = adjust(state.settings, key, input?.step === -1 ? -1 : 1);
          save(state);
        }
        emit("changed", {});
        return statePayload(input ?? {});
      },
      listAdd: async (input: any) => {
        const pattern = String(input?.pattern ?? "").trim();
        const { list, persist } = await listOf(input ?? {});
        if (isValid(pattern) && !list.includes(pattern)) {
          list.push(pattern);
          persist();
        }
        return statePayload(input ?? {});
      },
      listEdit: async (input: any) => {
        const pattern = String(input?.pattern ?? "").trim();
        const { list, persist } = await listOf(input ?? {});
        const index = Number(input?.index);
        if (isValid(pattern) && index >= 0 && index < list.length) {
          list[index] = pattern;
          persist();
        }
        return statePayload(input ?? {});
      },
      listRemove: async (input: any) => {
        const { list, persist } = await listOf(input ?? {});
        const index = Number(input?.index);
        if (index >= 0 && index < list.length) {
          list.splice(index, 1);
          persist();
        }
        return statePayload(input ?? {});
      },
      listPromote: async (input: any) => {
        const { list, kind, state } = await listOf({ ...(input ?? {}), scope: "project" });
        const index = Number(input?.index);
        if (index >= 0 && index < list.length) {
          const [pattern] = list.splice(index, 1);
          const global = globalLists();
          if (!global[kind].includes(pattern!)) global[kind].push(pattern!);
          try {
            saveProject(state);
            saveGlobal(global);
          } catch (error) {
            logError("promoting entry", error);
          }
          emit("changed", {});
        }
        return statePayload(input ?? {});
      },
      answer: async (input: any) => {
        const choice = input?.choice as Choice;
        const ask = [...shared.asks.values()].find((entry) => entry.id === input?.id);
        log("answer", { id: input?.id, choice, found: !!ask, pending: [...shared.asks.values()].map((entry) => entry.id) });
        if (ask && CHOICES.includes(choice)) {
          shared.asks.delete(`${ask.sessionID}\u0000${ask.target}`);
          const allowed = choice === "allow" || choice === "whitelist";
          if (choice === "allow" || choice === "reject") {
            runtime(ask.sessionID, ask.directory).once.set(ask.target, allowed);
          } else {
            const state = project(ask.directory);
            const list = state.lists[allowed ? "allow" : "deny"];
            const pattern = exact(ask.target);
            if (!list.includes(pattern)) list.push(pattern);
            save(state);
          }
          ask.resolve(allowed);
          emit("changed", {});
        }
        return { ok: !!ask };
      },
      release: async (input: any) => {
        if (typeof input?.sessionID === "string") {
          const { rootID } = await sessionInfo(input.sessionID);
          await release(rootID, "tab closed");
        }
        return { ok: true };
      },
    } as any);

    const copy: Copy = {
      emit: (event, payload) =>
        void registration.events.emit(event as any, json(payload) as any).catch((error: unknown) => logError(`emit ${event}`, error)),
      interrupt: (sessionID) => ctx.session.interrupt({ sessionID } as any),
      decide,
    };
    shared.copies.push(copy);

    // Tabs closed while no TUI was watching (crash, quit) never send `release`; idle runtimes go after a while.
    if (shared.sweeper) clearInterval(shared.sweeper);
    shared.sweeper = setInterval(() => {
      const now = Date.now();
      const busy = new Set([...shared.running.values()].map((call) => call.sessionID));
      for (const entry of shared.runtimes.values()) {
        if (!busy.has(entry.sessionID) && now - entry.lastUsed > IDLE_RELEASE_MS) void release(entry.sessionID, "idle");
      }
      for (const [id, call] of shared.running) if (now - call.at > IDLE_RELEASE_MS) shared.running.delete(id);
    }, SWEEP_EVERY_MS);
    (shared.sweeper as any).unref?.();

    // ---------------------------------------------------------------- hooks

    const before = await ctx.tool.hook("execute.before", async (event: any) => {
      try {
        const { directory, rootID } = await sessionInfo(event.sessionID);
        if (event.tool === "shell") {
          const command = typeof event.input?.command === "string" ? event.input.command : undefined;
          shared.running.set(String(event.id), { sessionID: rootID, directory, command, at: Date.now(), matched: false });
        }
        if (shared.checked.has(rootID) || !project(directory).settings.enabled) return;
        shared.checked.add(rootID);
        // Every new session checks again, so a fixed machine picks the sandbox back up.
        const problem = probe();
        if (!problem) return;
        shared.failed.add(rootID);
        emit("failed", { sessionID: rootID, directory, reason: problem, delaySeconds: options.failDelaySeconds });
        emit("changed", {});
        // Time to press escape before anything runs without the sandbox.
        await sleep(options.failDelaySeconds * 1000);
      } catch (error) {
        logError("execute.before", error);
      }
    });

    const after = await ctx.tool.hook("execute.after", async (event: any) => {
      shared.running.delete(String(event.id));
    });

    const shellHook = await ctx.shell.hook("create.before", async (event) => {
      try {
        const owner = shellOwner(event.cwd);
        const state = project(owner.directory);
        if (!state.settings.enabled) return;
        if (!shared.probed) probe();
        if (shared.problem || !shared.backend) return;
        const { settings } = state;
        const config = shared.options ?? options;
        const home = settings.syntheticHome ? join(stateDir(), "homes", projectHash(owner.directory)) : undefined;
        if (home) {
          mkdirSync(home, { recursive: true });
          event.env.HOME = home;
        }
        const spec: Spec = {
          project: owner.directory,
          cwd: event.cwd,
          shell: event.shell,
          command: event.command,
          settings,
          home,
          credentialPaths: config.credentialPaths.map(expandHome),
          extraReadPaths: config.extraReadPaths.map(expandHome),
          extraWritePaths: config.extraWritePaths.map(expandHome),
        };
        // Without a session (your own commands) there's nobody to ask: ask mode acts as closed.
        if (settings.networkOut === "ask" && shared.backend.supportsAsk && owner.sessionID) {
          const proxy = await proxyFor(runtime(owner.sessionID, owner.directory));
          spec.proxyPort = proxy.port;
          const url = `http://127.0.0.1:${proxy.port}`;
          for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "npm_config_proxy", "npm_config_https_proxy"]) {
            event.env[name] = url;
          }
          event.env.ALL_PROXY = event.env.all_proxy = `socks5h://127.0.0.1:${proxy.port}`;
          event.env.NO_PROXY = event.env.no_proxy = settings.localhost ? "localhost,127.0.0.1,::1" : "";
        }
        event.env.OPENCODE_SANDBOX = shared.backend.name;
        event.command = shared.backend.wrap(spec);
      } catch (error) {
        // Fail closed: a command we meant to sandbox but couldn't wrap doesn't run.
        logError("create.before", error);
        event.command = `echo 'opencode sandbox: could not start the sandbox for this command' >&2; exit 126`;
      }
    });

    // webfetch runs in OpenCode itself, outside the sandbox: send its host through the same lists and popup.
    const permission = await ctx.permission.hook("evaluate", async (event: any) => {
      if (event.action !== "webfetch" || event.effect === "deny") return;
      try {
        const { directory, rootID } = await sessionInfo(event.sessionID);
        if (!project(directory).settings.enabled) return;
        const raw = [...(event.resources ?? [])].find((resource: string) => /^https?:\/\//i.test(resource));
        if (!raw) return;
        const url = new URL(raw);
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        const target = `${url.hostname.replace(/^\[|\]$/g, "")}:${port}`;
        runtime(rootID, directory);
        if (await decide(rootID, target, `webfetch ${raw}`)) return;
        event.effect = "deny";
        event.message = `sandbox-mode: ${target} is not allowed in this project's sandbox`;
      } catch (error) {
        logError("webfetch check", error);
      }
    });

    return async () => {
      shared.copies = shared.copies.filter((entry) => entry !== copy);
      await Promise.allSettled([before.dispose(), after.dispose(), shellHook.dispose(), permission.dispose(), registration.dispose()]);
    };
  },
});
