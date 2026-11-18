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
}

export interface Options {
  defaults: ProjectSettings;
  keybind: string;
  askTimeoutSeconds: number;
  failDelaySeconds: number;
  credentialPaths: string[];
  extraReadPaths: string[];
  extraWritePaths: string[];
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
    },
    keybind: typeof options.keybind === "string" && options.keybind.trim() ? options.keybind.trim() : "<leader>o",
    askTimeoutSeconds: seconds(options.askTimeoutSeconds, 20),
    failDelaySeconds: seconds(options.failDelaySeconds, 4),
    credentialPaths: strings(options.credentialPaths) ?? DEFAULT_CREDENTIALS,
    extraReadPaths: strings(options.extraReadPaths) ?? [],
    extraWritePaths: strings(options.extraWritePaths) ?? [],
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
  { key: "projectOnlyWrites", label: "Project-only writes", description: "Writes only inside the project, temp folders and the sandbox home (plus extraWritePaths)" },
  { key: "syntheticHome", label: "Sandbox home", description: "HOME points at an empty per-project folder, so tools don't read or write your real dotfiles" },
  { key: "protectHooks", label: "Protect hooks", description: ".git/hooks, .git/config, .opencode and .envrc are read-only" },
  { key: "blockCredentials", label: "Block credentials", description: "credentialPaths (from opencode.jsonc) can't be read or written" },
  { key: "list:project:allow", label: "Project allowlist", description: "Regexes on host:port this project may connect to" },
  { key: "list:project:deny", label: "Project blocklist", description: "Regexes on host:port this project may never connect to" },
  { key: "list:global:allow", label: "Global allowlist", description: "Allowed in every project" },
  { key: "list:global:deny", label: "Global blocklist", description: "Blocked in every project" },
  { key: "openState", label: "Open state folder", description: "Settings, lists, sandbox homes and sandbox.log; opens in your file manager" },
];

export function adjust(settings: ProjectSettings, key: SettingKey, step: -1 | 1): ProjectSettings {
  const value = settings[key];
  if (typeof value === "boolean") return { ...settings, [key]: !value };
  const values: readonly string[] = key === "networkOut" ? NETWORK_OUT : NETWORK_IN;
  const index = values.indexOf(value);
  return { ...settings, [key]: values[(index + step + values.length) % values.length] };
}
