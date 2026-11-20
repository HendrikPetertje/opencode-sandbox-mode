/**
 * Sandbox mode: runs the agent's shell commands in an OS sandbox (Seatbelt on
 * macOS, bubblewrap on Linux), opt-in per project. Each session gets its own
 * sandbox runtime (network proxy, one-off answers), released when its tab
 * closes or after a while without use. See README.md.
 */
import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backendFor, type Backend, type Spec } from "./src/backend.ts";
import { BRIDGE_SOCKET, findForwarder, prepareBridge } from "./src/bridge.ts";
import { matchesName, proxyEnv, sandboxServer } from "./src/mcp.ts";
import { adjust, linkNetwork, resolveOptions, SETTING_ROWS, type Options, type SettingKey } from "./src/options.ts";
import { expandHome, isInside, linkIntoHome, lockedPaths, projectHash, real, stateDir } from "./src/paths.ts";
import { exact, isValid, judge } from "./src/patterns.ts";
import { startProxy, type Proxy } from "./src/proxy.ts";
import { SandboxMode } from "./src/rpc.ts";
import { hasProjectFiles, homeDir, loadGlobal, loadProject, removeProjectFiles, saveGlobal, saveProject, type Lists, type ProjectState } from "./src/state.ts";

const LOOKUP_TIMEOUT_MS = 3_000;
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_RETRY_MS = 250;
/** A pending shell call and its create.before are matched within this window. */
const SHELL_MATCH_MS = 30_000;
const SWEEP_EVERY_MS = 10 * 60_000;
/** Runtimes without a shell call or network request for this long are released (tabs closed while the TUI was gone). */
const IDLE_RELEASE_MS = 2 * 60 * 60_000;
type Choice = "allow" | "whitelist" | "reject" | "blacklist";
const CHOICES: Choice[] = ["allow", "whitelist", "reject", "blacklist"];
/** Permission actions of OpenCode's file-changing tools. */
const FILE_WRITE_ACTIONS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

interface Ask {
  id: string;
  /** Root session the sandbox runtime belongs to. */
  sessionID: string;
  directory: string;
  target: string;
  command?: string;
  deadline: number;
  /** Nothing of the agent is known to be behind this connection: a timeout refuses it but doesn't stop the agent. */
  quiet?: boolean;
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
  decide: (sessionID: string, target: string, command?: string, quiet?: boolean) => Promise<boolean>;
  /** Network decision for the MCP servers of one project: like a shell command of the session that is calling them. */
  decideMcp: (directory: string, target: string) => Promise<boolean>;
  /** Restarts this copy's MCP servers (each location has its own set). */
  reloadMcp: () => Promise<unknown>;
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
  running: Map<string, { sessionID: string; directory?: string; command?: string; at: number; matched: boolean }>;
  /** One proxy per project for its sandboxed MCP servers; it keeps its port across plugin reloads. */
  mcpProxies: Map<string, Promise<Proxy>>;
  /** Tool calls in flight (not shell): call ID -> root session and project. MCP traffic is attributed to these. */
  calls: Map<string, { sessionID: string; directory: string; at: number }>;
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
  const detail =
    error instanceof Error ? error.message || error.name : typeof error === "object" && error ? JSON.stringify(error) : String(error ?? "");
  log("error", { where, error: detail || "(no message)" });
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
    const { options, warning } = resolveOptions(ctx.options as Record<string, unknown>);
    if (warning) log("error", { where: "extends", error: warning });
    // All mutable state lives on globalThis: hooks, the TUI's RPC calls and the proxies can each land in a different copy.
    const shared = ((globalThis as any).__opencodeSandboxMode ??= {}) as Shared;
    shared.projects ??= new Map();
    shared.runtimes ??= new Map();
    shared.asks ??= new Map();
    shared.sessions ??= new Map();
    shared.running ??= new Map();
    shared.calls ??= new Map();
    shared.mcpProxies ??= new Map();
    shared.checked ??= new Set();
    shared.failed ??= new Set();
    shared.copies ??= [];
    shared.options = options;
    // Projects cached by an earlier copy (a hot reload keeps them) start locked again, like after a restart.
    for (const state of shared.projects.values()) state.settings = { ...state.settings, lockConfig: true };
    shared.backend = backendFor(process.platform);
    const latest = () => shared.copies.at(-1);
    const emit = (event: string, payload: Record<string, unknown>) => latest()?.emit(event, payload);

    const project = (directory: string): ProjectState => {
      let state = shared.projects.get(directory);
      if (!state) {
        state = loadProject(directory, shared.options ?? options);
        if (shared.backend?.linkedNetwork) state.settings = linkNetwork(state.settings);
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
    const locked = (directory: string): string[] => {
      const { settings } = project(directory);
      return settings.enabled && settings.lockConfig !== false ? lockedPaths(directory, (shared.options ?? options).homeLinks) : [];
    };

    const probe = (): string | undefined => {
      shared.probed = true;
      shared.problem = shared.backend ? shared.backend.probe() : `no sandbox for ${process.platform}`;
      return shared.problem;
    };

    // ---------------------------------------------------------------- sessions

    const fallbackDir = () => ctx.location?.directory ?? process.cwd();
    /**
     * A session's project directory and root session (subagents share their root's sandbox). A brand-new session can
     * briefly fail to look up, so this retries; if it still fails, `directory` is the caller's hint or undefined.
     * Never guess this copy's own location: that may be the home folder, which contains every project.
     */
    const sessionInfo = async (sessionID: string, hint?: string): Promise<{ directory?: string; rootID: string }> => {
      const known = shared.sessions.get(sessionID);
      if (known) return known;
      let failure: unknown;
      for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(LOOKUP_RETRY_MS * attempt);
        try {
          const got = await withTimeout<any>(ctx.session.get({ sessionID } as any), LOOKUP_TIMEOUT_MS);
          const directory: string | undefined = got?.location?.directory ?? hint;
          const rootID = got?.parentID ? (await sessionInfo(got.parentID, directory)).rootID : sessionID;
          if (!directory) return { rootID };
          const info = { directory, rootID };
          shared.sessions.set(sessionID, info);
          return info;
        } catch (error) {
          failure = error;
        }
      }
      logError(`session lookup ${sessionID} (${LOOKUP_ATTEMPTS} attempts)`, failure);
      return { directory: hint, rootID: sessionID };
    };
    const sessionDir = async (sessionID: string | undefined, hint?: string) =>
      (sessionID ? (await sessionInfo(sessionID, hint)).directory : undefined) ?? hint ?? fallbackDir();

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
      if (shared.backend?.linkedNetwork) rmSync(bridgeDir(entry), { recursive: true, force: true });
      emit("changed", {});
    };

    /**
     * create.before only knows the cwd and command. The shell call that started it was recorded by execute.before
     * just before: take the oldest unmatched one around the cwd for the session. The project is always the deepest
     * known project around the cwd, so a wrong or missing session directory can't widen it (e.g. to the home folder).
     */
    const shellOwner = (cwd: string): { sessionID?: string; directory: string } => {
      const now = Date.now();
      const candidates = [...shared.running.values()]
        .filter((call) => !call.matched && now - call.at < SHELL_MATCH_MS && (!call.directory || isInside(cwd, call.directory)))
        .sort((a, b) => a.at - b.at);
      const call = candidates[0];
      if (call) call.matched = true;
      const dirs = new Set([...shared.projects.keys(), ...[...shared.sessions.values()].map((info) => info.directory)]);
      if (call?.directory) dirs.add(call.directory);
      const home = homedir();
      const directory =
        [...dirs].filter((dir) => isInside(cwd, dir) && (dir !== home || cwd === home)).sort((a, b) => b.length - a.length)[0] ?? cwd;
      // Not an agent shell call (your own `!` command, a terminal): no session.
      return { sessionID: call?.sessionID, directory };
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
      quiet: ask.quiet ?? false,
    });

    /** Whether the root session `sessionID` may connect to `target` (`host:port`). */
    const decide = async (sessionID: string, target: string, command?: string, quiet = false): Promise<boolean> => {
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
      if (existing && !existing.settled) return existing.promise;
      if (existing) shared.asks.delete(key);

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
        quiet,
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
        // The connection is refused and the agent stops. The ask is dropped, so the next connection asks again.
        ask.resolve(false);
        if (shared.asks.get(key) === ask) shared.asks.delete(key);
        log("timeout", { id: ask.id, sessionID, target, quiet });
        emit("changed", {});
        // No call of the agent is known to be behind this connection: refuse it but leave the agent running.
        if (quiet) return;
        void latest()
          ?.interrupt(sessionID)
          .catch((error) => logError(`interrupt ${sessionID}`, error));
        emit("halted", { sessionID, directory, target });
      }, timeout);
      return promise;
    };

    /** Linux: the folder holding this runtime's proxy socket and forwarder, bind-mounted into the sandbox. */
    const bridgeDir = (entry: Runtime) => join(stateDir(), "run", projectHash(entry.sessionID));

    /** Proxies outlive the copy that started them, so they decide through the newest live copy. */
    const proxyFor = (entry: Runtime): Promise<Proxy> => {
      if (!entry.proxy) {
        let unixPath: string | undefined;
        const forwarder = shared.backend?.linkedNetwork ? findForwarder() : undefined;
        if (forwarder) {
          const dir = bridgeDir(entry);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          prepareBridge(dir, forwarder);
          unixPath = join(dir, BRIDGE_SOCKET);
        }
        entry.proxy = startProxy(async (target) => {
          entry.lastUsed = Date.now();
          const copy = latest();
          return copy ? copy.decide(entry.sessionID, target) : false;
        }, unixPath);
        entry.proxy.catch((error) => {
          logError("starting the proxy", error);
          entry.proxy = undefined;
        });
      }
      return entry.proxy;
    };

    // ---------------------------------------------------------------- RPC

    const statePayload = async (input: { sessionID?: string; directory?: string }) => {
      const info = input.sessionID ? await sessionInfo(input.sessionID, input.directory) : undefined;
      const directory = info?.directory ?? input.directory ?? fallbackDir();
      const state = project(directory);
      if (!shared.probed) probe();
      return json({
        directory,
        rootID: info?.rootID ?? null,
        enabled: state.settings.enabled,
        settings: state.settings,
        rows: SETTING_ROWS,
        files: { home: homeDir(directory), exists: hasProjectFiles(directory) },
        lists: { project: state.lists, global: globalLists(), config: { allow: options.allow, deny: options.deny } },
        keybind: options.keybind,
        failed: info ? shared.failed.has(info.rootID) : false,
        problem: shared.problem ?? null,
        backend: shared.backend?.name ?? null,
        askSupported: shared.backend?.supportsAsk ?? false,
        linkedNetwork: shared.backend?.linkedNetwork ?? false,
        asks: [...shared.asks.values()].filter((ask) => (info ? ask.sessionID === info.rootID : ask.directory === directory)).map(askPayload),
      });
    };

    type ListInput = { sessionID?: string; directory?: string; scope?: string; kind?: string; index?: number; pattern?: string };
    const listOf = async (input: ListInput) => {
      const directory = input.sessionID ? await sessionDir(input.sessionID, input.directory) : input.directory ?? fallbackDir();
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
    const projectOf = async (input: any) =>
      project(input?.sessionID ? await sessionDir(input.sessionID, input?.directory) : input?.directory ?? fallbackDir());

    const registration = await ctx.rpc.register(SandboxMode, {
      state: async (input: any) => statePayload(input ?? {}),
      toggle: async (input: any) => {
        const state = await projectOf(input);
        // Turning the sandbox on always switches the config lock back on.
        state.settings = { ...state.settings, enabled: !state.settings.enabled, lockConfig: true };
        save(state);
        emit("changed", {});
        await reloadMcp();
        return statePayload(input ?? {});
      },
      setSetting: async (input: any) => {
        const state = await projectOf(input);
        const key = input?.key as SettingKey;
        if (key in state.settings && key !== ("enabled" as string)) {
          state.settings = adjust(state.settings, key, input?.step === -1 ? -1 : 1, shared.backend?.linkedNetwork ?? false);
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
      removeFiles: async (input: any) => {
        const state = await projectOf(input);
        if (state.settings.enabled) {
          return { ...(await statePayload(input ?? {})), removed: false, reason: "The sandbox is on for this project. Turn it off first." };
        }
        try {
          removeProjectFiles(state.directory);
        } catch (error) {
          logError("removing the project's sandbox files", error);
          return { ...(await statePayload(input ?? {})), removed: false, reason: `Couldn't remove them: ${(error as Error)?.message ?? error}` };
        }
        // Forget the cached state too, or the next change would write the old settings and lists back.
        shared.projects.delete(state.directory);
        for (const entry of [...shared.runtimes.values()]) if (entry.directory === state.directory) await release(entry.sessionID, "files removed");
        log("project.files.removed", { directory: state.directory });
        emit("changed", {});
        return { ...(await statePayload(input ?? {})), removed: true };
      },
      release: async (input: any) => {
        if (typeof input?.sessionID === "string") {
          const { rootID } = await sessionInfo(input.sessionID);
          await release(rootID, "tab closed");
        }
        return { ok: true };
      },
    } as any);

    /**
     * MCP servers are shared by every session of a project, so a connection is attributed to the session whose tool call
     * is in flight (the latest one). With no call in flight (a server starting up) it is the project's session used last;
     * that one is only asked, the agent isn't stopped when you don't answer. With no session at all, only the lists decide.
     */
    const mcpOwner = (directory: string): { sessionID: string; quiet: boolean } | undefined => {
      const inside = (dir: string | undefined) => !!dir && (isInside(dir, directory) || isInside(directory, dir));
      const call = [...shared.calls.values()].filter((entry) => inside(entry.directory)).sort((a, b) => b.at - a.at)[0];
      if (call) return { sessionID: call.sessionID, quiet: false };
      const used = [...shared.runtimes.values()].filter((entry) => inside(entry.directory)).sort((a, b) => b.lastUsed - a.lastUsed)[0];
      if (used) return { sessionID: used.sessionID, quiet: true };
      const known = [...shared.sessions.values()].reverse().find((info) => inside(info.directory));
      return known ? { sessionID: known.rootID, quiet: true } : undefined;
    };

    const decideMcp = async (directory: string, target: string): Promise<boolean> => {
      const owner = mcpOwner(directory);
      if (!owner) {
        const state = project(directory);
        const allowed = state.settings.networkOut === "open" || judge(target, allLists(directory)) === "allow";
        log("mcp.network", { target, directory, allowed, reason: "no session to ask" });
        return allowed;
      }
      const allowed = await decide(owner.sessionID, target, "MCP server", owner.quiet);
      log("mcp.network", { target, directory, allowed, sessionID: owner.sessionID, quiet: owner.quiet });
      return allowed;
    };

    const copy: Copy = {
      emit: (event, payload) =>
        void registration.events.emit(event as any, json(payload) as any).catch((error: unknown) => logError(`emit ${event}`, error)),
      interrupt: (sessionID) => ctx.session.interrupt({ sessionID } as any),
      decide,
      decideMcp,
      reloadMcp: () => ctx.mcp.reload(),
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
      for (const [id, call] of shared.calls) if (now - call.at > IDLE_RELEASE_MS) shared.calls.delete(id);
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
        if (event.tool !== "shell" && directory) {
          shared.calls.set(String(event.id), { sessionID: rootID, directory, at: Date.now() });
        }
        if (!directory || shared.checked.has(rootID) || !project(directory).settings.enabled) return;
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
      shared.calls.delete(String(event.id));
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
        const home = settings.syntheticHome ? homeDir(owner.directory) : undefined;
        if (home) {
          mkdirSync(home, { recursive: true });
          linkIntoHome(home, config.homeLinks, config.credentialPaths.map(expandHome));
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
          lockedPaths: locked(owner.directory),
        };
        // Without a session (your own commands) there's nobody to ask: ask mode acts as closed.
        if (settings.networkOut === "ask" && shared.backend.supportsAsk && owner.sessionID) {
          const entry = runtime(owner.sessionID, owner.directory);
          const proxy = await proxyFor(entry);
          spec.proxyPort = proxy.port;
          // Linux: the sandbox's own 127.0.0.1:<port> is served by the forwarder, which talks to the proxy's socket.
          const forwarder = shared.backend.linkedNetwork ? findForwarder() : undefined;
          if (forwarder) spec.bridge = { dir: bridgeDir(entry), port: proxy.port, forwarder };
          Object.assign(event.env, proxyEnv(proxy.port, settings.localhost));
        }
        event.env.OPENCODE_SANDBOX = shared.backend.name;
        event.command = shared.backend.wrap(spec);
      } catch (error) {
        // Fail closed: a command we meant to sandbox but couldn't wrap doesn't run.
        logError("create.before", error);
        event.command = `echo 'opencode sandbox: could not start the sandbox for this command' >&2; exit 126`;
      }
    });

    // OpenCode's file tools run outside the sandbox, so the config lock has to refuse them here.
    const permission = await ctx.permission.hook("evaluate", async (event: any) => {
      if (!FILE_WRITE_ACTIONS.has(event.action) || event.effect === "deny") return;
      try {
        const { directory } = await sessionInfo(event.sessionID);
        const paths = directory ? locked(directory) : [];
        if (!directory || paths.length === 0) return;
        const candidates = [...(event.resources ?? []), ...Object.values(event.metadata ?? {}).filter((value) => typeof value === "string")];
        const hit = candidates.find((candidate: string) => {
          if (typeof candidate !== "string" || candidate === "*") return false;
          const path = real(candidate.startsWith("~") ? expandHome(candidate) : resolve(directory, candidate));
          return paths.some((locked) => isInside(path, locked));
        });
        if (!hit) return;
        event.effect = "deny";
        event.message = `sandbox-mode: ${hit} is part of the OpenCode config, which the sandbox keeps read-only (turn off "Lock opencode config edits" in the sandbox settings to allow it)`;
        log("lock.deny", { sessionID: event.sessionID, action: event.action, path: hit });
      } catch (error) {
        logError("config lock check", error);
      }
    });

    // Every location (project) has its own MCP servers and its own copy of this plugin: the servers follow the sandbox
    // of that project. With it off they start as configured.
    const mcpSandboxOn = () => project(fallbackDir()).settings.enabled;
    // Servers restart with the new command, or the original one, when the sandbox is turned on or off. Every location
    // has its own copy of the plugin and its own servers, so all live copies reload.
    const reloadMcp = async () => {
      if ((shared.options ?? options).sandboxMcp.length === 0) return;
      await Promise.allSettled(
        shared.copies.map((entry) => entry.reloadMcp().catch((error: unknown) => logError("reloading MCP servers", error))),
      );
    };

    // One proxy per project for its sandboxed MCP servers. Where there's no bridge for it (Linux), they get no network.
    let mcpPort: number | undefined;
    if (options.sandboxMcp.length > 0 && !shared.backend?.linkedNetwork) {
      const dir = fallbackDir();
      let proxy = shared.mcpProxies.get(dir);
      if (!proxy) {
        proxy = startProxy(async (target) => (await latest()?.decideMcp(dir, target)) ?? false);
        shared.mcpProxies.set(dir, proxy);
        proxy.catch((error) => {
          logError("starting the MCP proxy", error);
          shared.mcpProxies.delete(dir);
        });
      }
      mcpPort = await proxy.then((started) => started.port).catch(() => undefined);
    }

    // Local MCP servers listed in `sandboxMcp` only start inside the sandbox while it is on. If it can't start, they
    // don't start at all.
    const mcp = await ctx.mcp.transform((editor) => {
      const config = shared.options ?? options;
      const names = config.sandboxMcp.map((entry) => entry.name);
      const active = names.length > 0 && mcpSandboxOn();
      log("mcp.transform", {
        active,
        patterns: names,
        servers: editor.list().map(([name]) => name),
        projects: [...shared.projects.values()].map((state) => ({ directory: state.directory, enabled: state.settings.enabled })),
        location: fallbackDir(),
      });
      if (!active) return;
      for (const [name] of editor.list()) {
        const entry = config.sandboxMcp.find((candidate) => matchesName(name, [candidate.name]));
        if (!entry) continue;
        try {
          if (!shared.probed) probe();
          const backend = shared.backend;
          const current = editor.get(name) as any;
          if (shared.problem || !backend) {
            logError(`mcp ${name} not started: ${shared.problem ?? "no sandbox backend"}`);
            editor.update(name, (server: any) => void (server.disabled = true));
            continue;
          }
          const result = sandboxServer(name, current, { backend, args: entry.args, proxyPort: mcpPort, credentialPaths: config.credentialPaths.map(expandHome), homeLinks: config.homeLinks });
          if (!result.ok) {
            log("mcp.skip", { name, reason: result.reason });
            continue;
          }
          editor.update(name, (server: any) => void Object.assign(server, result.server));
          log("mcp.sandboxed", { name, command: result.server.command?.slice(0, 2) });
        } catch (error) {
          // Fail closed: a server we meant to sandbox but couldn't doesn't start.
          logError(`mcp ${name}`, error);
          editor.update(name, (server: any) => void (server.disabled = true));
        }
      }
    });

    // webfetch runs in OpenCode itself, outside the sandbox: send its host through the same lists and popup.
    const webfetchPermission = await ctx.permission.hook("evaluate", async (event: any) => {
      if (event.action !== "webfetch" || event.effect === "deny") return;
      try {
        const { directory, rootID } = await sessionInfo(event.sessionID);
        if (!directory) {
          // Unknown project: if any project has the sandbox on, let the user decide rather than guess.
          if ([...shared.projects.values()].some((state) => state.settings.enabled)) {
            event.effect = "ask";
            event.message = "sandbox-mode: couldn't tell which project this session belongs to, so you decide";
          }
          return;
        }
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
      await Promise.allSettled([before.dispose(), after.dispose(), shellHook.dispose(), permission.dispose(), webfetchPermission.dispose(), mcp.dispose(), registration.dispose()]);
    };
  },
});
