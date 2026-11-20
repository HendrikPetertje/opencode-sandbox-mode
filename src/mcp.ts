import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Backend, Spec } from "./backend.ts";
import type { ProjectSettings } from "./options.ts";
import { linkIntoHome, lockedPaths, projectHash, stateDir } from "./paths.ts";

/**
 * MCP servers have no session to ask. They write only to their own folder and temp (and to the project when its
 * "MCP writes to project" setting is on; they can always read it), and reach the
 * network only through the plugin's proxy, which answers from the allow lists (unknown hosts are refused). Without
 * a proxy port (Linux has no bridge for this yet) they get no network at all.
 */
const mcpSettings = (proxied: boolean, projectWrite: boolean): ProjectSettings => ({
  enabled: true,
  networkOut: proxied ? "ask" : "closed",
  networkIn: "closed",
  localhost: false,
  projectOnlyWrites: true,
  syntheticHome: true,
  // With write access to the project, its git hooks, git config and OpenCode config stay read-only, as for shell commands.
  protectHooks: projectWrite,
  blockCredentials: true,
  lockConfig: true,
});

/** What makes proxy-aware tools use the plugin's proxy. Also used for shell commands. */
export function proxyEnv(port: number, localhost: boolean): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {};
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "npm_config_proxy", "npm_config_https_proxy"]) env[name] = url;
  env.ALL_PROXY = env.all_proxy = `socks5h://127.0.0.1:${port}`;
  // Node's own fetch and http clients ignore the variables above without this (Node 24+).
  env.NODE_USE_ENV_PROXY = "1";
  env.NO_PROXY = env.no_proxy = localhost ? "localhost,127.0.0.1,::1" : "";
  return env;
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `chrome-devtools*` matches `chrome-devtools` and `chrome-devtools-foo`. Case-insensitive. */
export const matchesName = (name: string, patterns: string[]): boolean =>
  patterns.some((pattern) => new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`, "i").test(name));

export interface McpServer {
  type: string;
  command?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  disabled?: boolean;
}

export interface McpContext {
  backend: Backend;
  /** Added to the server's command inside the sandbox only (e.g. flags that make a browser work without its own sandbox). */
  args?: string[];
  /** The plugin's MCP proxy; without it the server gets no network. */
  proxyPort?: number;
  /** The project (location) the server belongs to. Its folder under `mcp/<name>/` is per project. */
  project: string;
  /** The project's "MCP writes to project" setting: the server may write to the project folder and starts in it. */
  projectWrite?: boolean;
  credentialPaths: string[];
  homeLinks: string[];
}

/** A server's own folder (HOME) for one project. */
export const mcpDir = (name: string, project: string) => join(stateDir(), "mcp", name.replace(/[^A-Za-z0-9._-]/g, "_"), projectHash(project));

/**
 * Rewrites a local MCP server so it starts inside the sandbox: HOME and the working folder are the server's own
 * folder under the state folder, and `command` becomes the sandbox wrapper plus the original command.
 * Returns what changed, or why the server can't be sandboxed.
 */
export function sandboxServer(name: string, server: McpServer, context: McpContext): { ok: true; server: McpServer } | { ok: false; reason: string } {
  if (server.type !== "local" || !server.command?.length) return { ok: false, reason: "only local servers can be sandboxed" };
  const [first] = server.command;
  if (first === "/usr/bin/sandbox-exec" || first === "bwrap") return { ok: true, server };
  const dir = mcpDir(name, context.project);
  const projectWrite = context.projectWrite === true;
  mkdirSync(dir, { recursive: true });
  linkIntoHome(dir, context.homeLinks, context.credentialPaths);
  const spec: Spec = {
    // The project is the writable folder; the server's own folder is writable as its home.
    project: projectWrite ? context.project : dir,
    cwd: projectWrite ? context.project : dir,
    shell: "",
    command: "",
    settings: mcpSettings(context.proxyPort !== undefined, projectWrite),
    proxyPort: context.proxyPort,
    home: dir,
    credentialPaths: context.credentialPaths,
    lockedPaths: lockedPaths(projectWrite ? context.project : dir, context.homeLinks),
  };
  return {
    ok: true,
    server: {
      ...server,
      command: context.backend.wrapArgv(spec, [...server.command, ...(context.args ?? [])]),
      cwd: server.cwd ?? (projectWrite ? context.project : dir),
      environment: {
        ...(server.environment ?? {}),
        ...(context.proxyPort !== undefined ? proxyEnv(context.proxyPort, false) : {}),
        HOME: dir,
        OPENCODE_SANDBOX: context.backend.name,
      },
    },
  };
}
