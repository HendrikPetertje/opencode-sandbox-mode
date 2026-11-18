/** Allow/block entries are regexes tested against `host:port`, e.g. `^registry\.npmjs\.org:443$`. */

const cache = new Map<string, RegExp | null>();

export function compile(pattern: string): RegExp | null {
  if (!cache.has(pattern)) {
    try {
      cache.set(pattern, new RegExp(pattern, "i"));
    } catch {
      cache.set(pattern, null);
    }
  }
  return cache.get(pattern)!;
}

export const isValid = (pattern: string) => pattern.trim() !== "" && compile(pattern) !== null;

export const matches = (patterns: readonly string[], target: string) => patterns.some((pattern) => compile(pattern)?.test(target) ?? false);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The entry the Ask popup saves for a target. */
export const exact = (target: string) => `^${escape(target)}$`;

export type Verdict = "allow" | "deny" | "ask";

/** Block lists win over allow lists; project and global lists count the same. */
export function judge(target: string, lists: { allow: readonly string[]; deny: readonly string[] }): Verdict {
  if (matches(lists.deny, target)) return "deny";
  if (matches(lists.allow, target)) return "allow";
  return "ask";
}
