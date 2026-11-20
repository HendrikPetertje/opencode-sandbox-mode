/**
 * Which sandboxes exist on this machine and which of them are in use. State is per OpenCode process, so every process
 * writes a small heartbeat file (`live/<pid>.json`) with the projects it has the sandbox on for; a project is live when
 * a fresh file of a running process lists it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";
import { homeDirOf, mcpDirsOf, projectFileOf } from "./state.ts";

export const HEARTBEAT_MS = 20_000;
/** A heartbeat older than this is ignored, also when its process still exists. */
export const FRESH_MS = 90_000;

export interface SandboxInfo {
  hash: string;
  /** Unknown when only a home folder is left (its settings file is gone). */
  directory: string | null;
  /** Whether the project folder still exists. */
  exists: boolean;
  /** The saved on/off flag. It can be stale: it says nothing about OpenCode running. */
  enabled: boolean;
  /** Live in this OpenCode. */
  here: boolean;
  /** Live in another running OpenCode. */
  elsewhere: boolean;
  /** here or elsewhere: it can't be wiped. */
  live: boolean;
  /** The project of the window asking. */
  current: boolean;
  allow: number;
  deny: number;
  hasHome: boolean;
}

const liveDir = () => join(stateDir(), "live");
const liveFile = (pid: number) => join(liveDir(), `${pid}.json`);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function writeLive(pid: number, directories: string[], now = Date.now()): void {
  mkdirSync(liveDir(), { recursive: true });
  const tmp = `${liveFile(pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, at: now, directories }));
  renameSync(tmp, liveFile(pid));
}

export const removeLive = (pid: number): void => rmSync(liveFile(pid), { force: true });

/** directory -> pids of running OpenCodes that have its sandbox on. Dead or stale heartbeats are deleted. */
export function readLive(now = Date.now()): Map<string, number[]> {
  const live = new Map<string, number[]>();
  let names: string[] = [];
  try {
    names = readdirSync(liveDir());
  } catch {
    return live;
  }
  for (const name of names) {
    const path = join(liveDir(), name);
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (!Number.isInteger(data?.pid) || !alive(data.pid) || now - Number(data.at) > FRESH_MS) {
        rmSync(path, { force: true });
        continue;
      }
      for (const directory of Array.isArray(data.directories) ? data.directories : []) {
        if (typeof directory === "string") live.set(directory, [...(live.get(directory) ?? []), data.pid]);
      }
    } catch {
      rmSync(path, { force: true });
    }
  }
  return live;
}

const hashes = (dir: string, suffix = ""): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix) && /^[0-9a-f]{16}$/.test(name.slice(0, name.length - suffix.length)))
      .map((name) => name.slice(0, name.length - suffix.length));
  } catch {
    return [];
  }
};

/** The hashes of projects that have MCP server folders: `mcp/<server>/<hash>`. */
function mcpHashes(): string[] {
  try {
    return readdirSync(join(stateDir(), "mcp")).flatMap((name) => hashes(join(stateDir(), "mcp", name)));
  } catch {
    return [];
  }
}
const allHashes = () =>
  new Set([...hashes(join(stateDir(), "projects"), ".json"), ...hashes(join(stateDir(), "homes")), ...mcpHashes()]);

/** How many sandboxes exist (cheap: no files are read). */
export const countSandboxes = (): number => allHashes().size;

export function listSandboxes(options: { pid: number; current?: string; now?: number }): SandboxInfo[] {
  const live = readLive(options.now);
  const list: SandboxInfo[] = [];
  for (const hash of allHashes()) {
    let stored: any;
    try {
      stored = JSON.parse(readFileSync(projectFileOf(hash), "utf8"));
    } catch {}
    const directory = typeof stored?.directory === "string" ? stored.directory : null;
    const pids = directory ? live.get(directory) ?? [] : [];
    const here = pids.includes(options.pid);
    const elsewhere = pids.some((pid) => pid !== options.pid);
    list.push({
      hash,
      directory,
      exists: directory ? existsSync(directory) : false,
      enabled: stored?.settings?.enabled === true,
      here,
      elsewhere,
      live: here || elsewhere,
      current: !!directory && directory === options.current,
      allow: Array.isArray(stored?.lists?.allow) ? stored.lists.allow.length : 0,
      deny: Array.isArray(stored?.lists?.deny) ? stored.lists.deny.length : 0,
      hasHome: existsSync(homeDirOf(hash)) || mcpDirsOf(hash).length > 0,
    });
  }
  // In use first, then the ones whose folder is gone, then the rest by path.
  const rank = (info: SandboxInfo) => (info.live ? 0 : info.exists ? 2 : 1);
  return list.sort((a, b) => rank(a) - rank(b) || (a.directory ?? "~").localeCompare(b.directory ?? "~"));
}
