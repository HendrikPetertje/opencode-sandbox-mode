import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDir, expandHome } from "./paths.ts";

export const NETWORK_OUT = ["open", "ask", "closed"] as const;
export const NETWORK_IN = ["open", "closed"] as const;
export type NetworkOut = (typeof NETWORK_OUT)[number];
export type NetworkIn = (typeof NETWORK_IN)[number];

/** What a project can change in the modal. New projects start from the plugin options. */
export interface ProjectSettings {
  enabled: boolean;
  networkOut: NetworkOut;
  networkIn: NetworkIn;
  localhost: boolean;
  projectOnlyWrites: boolean;
  syntheticHome: boolean;
  protectHooks: boolean;
  blockCredentials: boolean;
  /** Keeps the OpenCode config read-only. Never stored: it is on again every time the sandbox is turned on. */
  lockConfig: boolean;
}

export interface Options {
  defaults: ProjectSettings;
  keybind: string;
  askTimeoutSeconds: number;
  failDelaySeconds: number;
  credentialPaths: string[];
  /** Paths in your real home that are symlinked into the sandbox home (same relative path), e.g. `~/.config/containers`. */
  homeLinks: string[];
  allow: string[];
  deny: string[];
}

export const DEFAULT_CREDENTIALS = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.gnupg",
  "~/.docker/config.json",
  "~/.kube",
  "~/.netrc",
  "~/.npmrc",
  "~/.git-credentials",
  "~/.local/share/opencode/auth.json",
];

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : undefined;
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const seconds = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

/** Strips comments and trailing commas, so a `.jsonc` file can go through JSON.parse. Strings are left alone. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[\]}])/g, "$1");
}

/**
 * Options from opencode.jsonc, extended by the file named in `extends` (jsonc). Keys in that file win over the
 * inline ones. A missing file is fine (it's meant to be git-ignored); an unreadable one is reported in `warning`.
 */
export function resolveOptions(raw: Record<string, unknown> | undefined): { options: Options; warning?: string } {
  const inline = raw ?? {};
  const source = typeof inline.extends === "string" ? inline.extends.trim() : "";
  if (!source) return { options: parseOptions(inline) };
  const path = source.startsWith("~") ? expandHome(source) : resolve(configDir(), source);
  if (!existsSync(path)) return { options: parseOptions(inline) };
  try {
    const extra = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("expected an object");
    const { extends: _ignored, ...rest } = extra as Record<string, unknown>;
    return { options: parseOptions({ ...inline, ...rest }) };
  } catch (error) {
    return { options: parseOptions(inline), warning: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function parseOptions(raw: Record<string, unknown> | undefined): Options {
  const options = raw ?? {};
  return {
    defaults: {
      enabled: bool(options.enabled, false),
      networkOut: pick(options.networkOut, NETWORK_OUT, "ask"),
      networkIn: pick(options.networkIn, NETWORK_IN, "closed"),
      localhost: bool(options.localhost, true),
      projectOnlyWrites: bool(options.projectOnlyWrites, true),
      syntheticHome: bool(options.syntheticHome, true),
      protectHooks: bool(options.protectHooks, true),
      blockCredentials: bool(options.blockCredentials, true),
      lockConfig: true,
    },
    keybind: typeof options.keybind === "string" && options.keybind.trim() ? options.keybind.trim() : "<leader>o",
    askTimeoutSeconds: seconds(options.askTimeoutSeconds, 20),
    failDelaySeconds: seconds(options.failDelaySeconds, 4),
    credentialPaths: strings(options.credentialPaths) ?? DEFAULT_CREDENTIALS,
    homeLinks: strings(options.homeLinks) ?? [],
    allow: strings(options.allow) ?? [],
    deny: strings(options.deny) ?? [],
  };
}

export type SettingKey = Exclude<keyof ProjectSettings, "enabled">;

export interface SettingRow {
  key: SettingKey | "list:project:allow" | "list:project:deny" | "list:global:allow" | "list:global:deny" | "openState";
  label: string;
  description: string;
}

export const SETTING_ROWS: SettingRow[] = [
  { key: "networkOut", label: "Network out", description: "open: everything · ask: a popup for each new host · closed: nothing, lists ignored" },
  { key: "networkIn", label: "Network in", description: "open: commands may listen on ports · closed: listening is blocked" },
  { key: "localhost", label: "Localhost", description: "With network out on ask or closed: still allow connections to this machine (dev servers, databases)" },
  { key: "projectOnlyWrites", label: "Project-only writes", description: "Writes only inside the project and temp folders and the sandbox home" },
  { key: "syntheticHome", label: "Sandbox home", description: "HOME points at an empty per-project folder, so tools don't read or write your real dotfiles" },
  { key: "protectHooks", label: "Protect hooks", description: ".git/hooks, .git/config, .opencode and .envrc are read-only" },
  { key: "blockCredentials", label: "Block credentials", description: "credentialPaths (from opencode.jsonc) can't be read or written" },
  {
    key: "lockConfig",
    label: "Lock opencode config edits",
    description:
      "OpenCode config, this plugin's state and homeLinks targets can't be changed: file tools are denied and shell writes blocked. Switches back on every time the sandbox is turned on",
  },
  { key: "list:project:allow", label: "Project allowlist", description: "Regexes on host:port this project may connect to" },
  { key: "list:project:deny", label: "Project blocklist", description: "Regexes on host:port this project may never connect to" },
  { key: "list:global:allow", label: "Global allowlist", description: "Allowed in every project" },
  { key: "list:global:deny", label: "Global blocklist", description: "Blocked in every project" },
  { key: "openState", label: "Open state folder", description: "Settings, lists, sandbox homes and sandbox.log; opens in your file manager" },
];

/**
 * `linked` (Linux): one network namespace decides both directions, so open out means open in, and ask/closed out
 * means closed in. Changing either moves the other.
 */
export function adjust(settings: ProjectSettings, key: SettingKey, step: -1 | 1, linked = false): ProjectSettings {
  const value = settings[key];
  if (typeof value === "boolean") return { ...settings, [key]: !value };
  const values: readonly string[] = key === "networkOut" ? NETWORK_OUT : NETWORK_IN;
  const index = values.indexOf(value);
  const next = { ...settings, [key]: values[(index + step + values.length) % values.length] };
  if (!linked) return next;
  if (key === "networkOut") return linkNetwork(next);
  return { ...next, networkOut: next.networkIn === "open" ? "open" : settings.networkOut === "open" ? "ask" : settings.networkOut };
}

/** Makes network in follow network out, for platforms where they can't differ. */
export const linkNetwork = (settings: ProjectSettings): ProjectSettings => ({
  ...settings,
  networkIn: settings.networkOut === "open" ? "open" : "closed",
});
