import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...rest);
  } catch {
    return path;
  }
}

export const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * Symlinks paths from the real home into the sandbox home, at the same relative path. Paths outside the real home,
 * ones that don't exist, and ones inside `blocked` (credential paths) are skipped.
 */
export function linkIntoHome(sandboxHome: string, links: string[], blocked: string[], realHome = homedir()): void {
  for (const link of links) {
    const source = link === "~" || link.startsWith("~/") ? join(realHome, link.slice(2)) : resolve(link);
    if (source === realHome || !isInside(source, realHome) || !existsSync(source)) continue;
    if (blocked.some((path) => isInside(real(source), real(path)))) continue;
    const target = join(sandboxHome, source.slice(realHome.length + 1));
    try {
      mkdirSync(dirname(target), { recursive: true });
      try {
        if (readlinkSync(target) === source) continue;
        unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      symlinkSync(source, target);
    } catch {}
  }
}

/** The OpenCode config folder; relative `extends` paths are relative to it. */
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

/**
 * What the config lock keeps read-only: the OpenCode config folders, this plugin's own state (it holds the
 * on/off flag), the project's OpenCode config files, and the targets of `homeLinks`.
 */
export function lockedPaths(project: string, homeLinks: string[]): string[] {
  const paths = [
    configDir(),
    process.env.OPENCODE_CONFIG_DIR,
    stateDir(),
    join(project, "opencode.json"),
    join(project, "opencode.jsonc"),
    join(project, ".opencode"),
    ...homeLinks.map(expandHome),
  ].filter((path): path is string => !!path);
  return [...new Set(paths.map(real))];
}
