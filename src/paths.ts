import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/**
 * State lives outside every watched directory: writing under the config dir or
 * a project makes OpenCode reload plugins in a loop.
 */
export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-sandbox-mode");
}

export function projectHash(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 16);
}

/** Resolves symlinks (macOS `/var` -> `/private/var`); for paths that don't exist yet, resolves the nearest parent. */
export function real(path: string): string {
  let current = path;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    rest.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...rest);
  } catch {
    return path;
  }
}

export const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
