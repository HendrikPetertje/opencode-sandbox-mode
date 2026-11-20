import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_MOUNT, bridgePrelude, findForwarder, type Forwarder } from "./bridge.ts";
import type { ProjectSettings } from "./options.ts";
import { real } from "./paths.ts";

export interface Spec {
  project: string;
  cwd: string;
  shell: string;
  command: string;
  settings: ProjectSettings;
  /** Set in "ask" mode: the only outside host the sandbox may reach (inside the sandbox on Linux). */
  proxyPort?: number;
  /** Linux "ask" mode: the folder with the proxy's unix socket, and the forwarder that serves `proxyPort` from it. */
  bridge?: { dir: string; port: number; forwarder: Forwarder };
  /** The synthetic home, when that setting is on. */
  home?: string;
  credentialPaths: string[];
  /** Read-only for the shell, also under writable folders. Empty when the config lock is off. */
  lockedPaths: string[];
}

export interface Backend {
  name: string;
  /** Whether "ask" mode works here (Linux needs python3 or node for the bridge). */
  readonly supportsAsk: boolean;
  /** Network in and out can't be set apart (Linux: one network namespace covers both). */
  linkedNetwork: boolean;
  /** Undefined when it works, otherwise why not. */
  probe(): string | undefined;
  wrap(spec: Spec): string;
  /** The same sandbox around a program and its arguments (for MCP servers), without a shell in between. */
  wrapArgv(spec: Spec, argv: string[]): string[];
}

export const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const sb = (text: string) => JSON.stringify(text);

const protectedPaths = (project: string) => [
  { path: join(project, ".git", "hooks"), dir: true },
  { path: join(project, ".git", "config"), dir: false },
  { path: join(project, ".opencode"), dir: true },
  { path: join(project, ".envrc"), dir: false },
];

export function seatbeltProfile(spec: Spec): string {
  const { settings } = spec;
  const lines = ["(version 1)", "(allow default)"];
  const project = real(spec.project);

  if (settings.projectOnlyWrites) {
    const writable = [project, "/private/tmp", "/private/var/folders"];
    if (spec.home) writable.push(real(spec.home));
    lines.push("(deny file-write*)");
    lines.push(`(allow file-write* ${writable.map((path) => `(subpath ${sb(path)})`).join(" ")} (regex #"^/dev/"))`);
  }
  if (settings.protectHooks) {
    lines.push(`(deny file-write* ${protectedPaths(project).map(({ path }) => `(subpath ${sb(path)})`).join(" ")})`);
  }
  if (spec.lockedPaths.length > 0) {
    lines.push(`(deny file-write* ${spec.lockedPaths.map((path) => `(subpath ${sb(real(path))})`).join(" ")})`);
    // The sandbox home lives inside the locked plugin state folder.
    if (spec.home) lines.push(`(allow file-write* (subpath ${sb(real(spec.home))}))`);
  }
  if (settings.blockCredentials && spec.credentialPaths.length > 0) {
    lines.push(`(deny file-read* file-write* ${spec.credentialPaths.map((path) => `(subpath ${sb(real(path))})`).join(" ")})`);
  }

  if (settings.networkOut !== "open") {
    lines.push("(deny network-outbound)");
    lines.push("(allow network-outbound (remote unix-socket))");
    if (settings.localhost) lines.push('(allow network-outbound (remote ip "localhost:*"))');
    if (settings.networkOut === "ask" && spec.proxyPort) lines.push(`(allow network-outbound (remote ip "localhost:${spec.proxyPort}"))`);
  }
  if (settings.networkIn === "closed") {
    lines.push('(deny network-bind (local ip "*:*"))');
    lines.push('(deny network-inbound (local ip "*:*"))');
  }
  return lines.join("\n");
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export const seatbelt: Backend = {
  name: "seatbelt",
  supportsAsk: true,
  linkedNetwork: false,
  probe() {
    if (!existsSync(SANDBOX_EXEC)) return `${SANDBOX_EXEC} not found`;
    const result = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5000 });
    if (result.error) return result.error.message;
    return result.status === 0 ? undefined : `sandbox-exec exited with ${result.status}: ${result.stderr?.toString().trim()}`;
  },
  wrap(spec) {
    return `${SANDBOX_EXEC} -p ${quote(seatbeltProfile(spec))} ${quote(spec.shell)} -c ${quote(spec.command)}`;
  },
  wrapArgv(spec, argv) {
    return [SANDBOX_EXEC, "-p", seatbeltProfile(spec), ...argv];
  },
};

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function bwrapArgs(spec: Spec): string[] {
  const { settings } = spec;
  const args = ["--die-with-parent"];
  if (settings.projectOnlyWrites) {
    args.push("--ro-bind", "/", "/", "--tmpfs", "/tmp", "--bind", spec.project, spec.project);
    if (spec.home) args.push("--bind", spec.home, spec.home);
  } else {
    args.push("--bind", "/", "/");
  }
  args.push("--dev", "/dev", "--proc", "/proc");
  if (settings.protectHooks) {
    for (const { path } of protectedPaths(spec.project)) if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  for (const path of spec.lockedPaths) if (existsSync(path)) args.push("--ro-bind", path, path);
  if (spec.home && spec.lockedPaths.length > 0) args.push("--bind", spec.home, spec.home);
  if (settings.blockCredentials) {
    for (const path of spec.credentialPaths) {
      if (!existsSync(path)) continue;
      // Credentials inside a writable bind would be hidden too, so the order matters: these go last.
      if (isDir(path)) args.push("--tmpfs", path);
      else args.push("--ro-bind", "/dev/null", path);
    }
  }
  // Its own network namespace: nothing gets out, and nothing outside can connect in. "ask" goes through the bridge.
  if (settings.networkOut !== "open") args.push("--unshare-net");
  if (spec.bridge) args.push("--unshare-pid", "--bind", spec.bridge.dir, BRIDGE_MOUNT);
  args.push("--chdir", spec.cwd);
  return args;
}

export const bwrap: Backend = {
  name: "bubblewrap",
  // Ask needs an interpreter for the forwarder inside the sandbox.
  get supportsAsk() {
    return findForwarder() !== undefined;
  },
  linkedNetwork: true,
  probe() {
    const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "true"], {
      timeout: 5000,
    });
    if (result.error) return (result.error as NodeJS.ErrnoException).code === "ENOENT" ? "bwrap (bubblewrap) is not installed" : result.error.message;
    return result.status === 0 ? undefined : `bwrap exited with ${result.status}: ${result.stderr?.toString().trim()}`;
  },
  wrap(spec) {
    const args = bwrapArgs(spec).map(quote).join(" ");
    if (!spec.bridge) return `bwrap ${args} ${quote(spec.shell)} -c ${quote(spec.command)}`;
    const prelude = bridgePrelude(spec.bridge.forwarder, spec.bridge.port);
    return `bwrap ${args} /bin/sh -c ${quote(prelude)} ${quote(spec.shell)} ${quote(spec.command)}`;
  },
  wrapArgv(spec, argv) {
    return ["bwrap", ...bwrapArgs(spec), ...argv];
  },
};

export function backendFor(platform: NodeJS.Platform): Backend | undefined {
  if (platform === "darwin") return seatbelt;
  if (platform === "linux") return bwrap;
  return undefined;
}

