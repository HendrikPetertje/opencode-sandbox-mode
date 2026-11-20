import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, ProjectSettings } from "./options.ts";
import { projectHash, stateDir } from "./paths.ts";

export interface Lists {
  allow: string[];
  deny: string[];
}

export interface ProjectState {
  directory: string;
  settings: ProjectSettings;
  lists: Lists;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

export const projectFile = (directory: string) => join(stateDir(), "projects", `${projectHash(directory)}.json`);
export const globalFile = () => join(stateDir(), "global.json");
/** The sandbox HOME of a project. */
export const homeDir = (directory: string) => join(stateDir(), "homes", projectHash(directory));

/** Whether the sandbox left anything on disk for this project. */
export const hasProjectFiles = (directory: string) => existsSync(homeDir(directory)) || existsSync(projectFile(directory));

/**
 * Deletes what the sandbox made for one project: its home folder and its saved settings and lists. Symlinks in the
 * home (`homeLinks`) are removed, never followed, so their targets stay.
 */
export function removeProjectFiles(directory: string): void {
  rmSync(homeDir(directory), { recursive: true, force: true });
  rmSync(projectFile(directory), { force: true });
}

/**
 * Project files are created from the plugin options the first time a project
 * is seen; after that only the UI changes them.
 */
export function loadProject(directory: string, options: Options): ProjectState {
  const stored = readJson(projectFile(directory));
  return {
    directory,
    settings: { ...options.defaults, ...(stored?.settings ?? {}), lockConfig: true },
    lists: { allow: stringList(stored?.lists?.allow), deny: stringList(stored?.lists?.deny) },
  };
}

/** `lockConfig` is left out on purpose: it has to be switched off by hand after every start and every sandbox on. */
export const saveProject = (state: ProjectState) => {
  const { lockConfig: _lock, ...settings } = state.settings;
  writeJson(projectFile(state.directory), { ...state, settings });
};

export function loadGlobal(): Lists {
  const stored = readJson(globalFile());
  return { allow: stringList(stored?.allow), deny: stringList(stored?.deny) };
}

export const saveGlobal = (lists: Lists) => writeJson(globalFile(), lists);
