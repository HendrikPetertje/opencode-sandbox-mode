import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, seatbelt, seatbeltProfile, type Spec } from "./backend.ts";
import { adjust, parseOptions, resolveOptions, SETTING_ROWS, stripJsonc } from "./options.ts";
import { linkIntoHome, lockedPaths } from "./paths.ts";
import { matchesName, sandboxServer } from "./mcp.ts";
import { FRESH_MS, listSandboxes, readLive, removeLive, writeLive } from "./sandboxes.ts";
import { projectHash } from "./paths.ts";
import { hasProjectFiles, homeDir, removeProjectFilesByHash, loadProject, projectFile, removeProjectFiles, saveProject } from "./state.ts";
import { exact, judge } from "./patterns.ts";
import { startProxy } from "./proxy.ts";

const settings = parseOptions({ enabled: true }).defaults;

describe("patterns", () => {
  test("exact escapes the host", () => {
    expect(exact("www.example.com:443")).toBe("^www\\.example\\.com:443$");
    expect(new RegExp(exact("www.example.com:443")).test("wwwXexample.com:443")).toBe(false);
  });
  test("block lists win", () => {
    expect(judge("a.example.com:443", { allow: ["example\\.com"], deny: ["^a\\."] })).toBe("deny");
    expect(judge("b.example.com:443", { allow: ["example\\.com"], deny: ["^a\\."] })).toBe("allow");
    expect(judge("other:80", { allow: [], deny: ["("] })).toBe("ask");
  });
});

describe("options", () => {
  test("defaults", () => {
    const options = parseOptions({});
    expect(options.defaults.enabled).toBe(false);
    expect(options.defaults.networkOut).toBe("ask");
    expect(options.keybind).toBe("<leader>o");
    expect(options.askTimeoutSeconds).toBe(20);
  });
  test("adjust cycles enums and flips booleans", () => {
    expect(adjust(settings, "networkOut", 1).networkOut).toBe("closed");
    expect(adjust(settings, "networkOut", -1).networkOut).toBe("open");
    expect(adjust(settings, "localhost", 1).localhost).toBe(!settings.localhost);
  });
  test("linked network moves in and out together", () => {
    const open = adjust(settings, "networkOut", -1, true);
    expect(open).toMatchObject({ networkOut: "open", networkIn: "open" });
    expect(adjust(open, "networkOut", 1, true)).toMatchObject({ networkOut: "ask", networkIn: "closed" });
    expect(adjust(open, "networkIn", 1, true)).toMatchObject({ networkOut: "ask", networkIn: "closed" });
    const closed = { ...settings, networkOut: "closed" as const, networkIn: "closed" as const };
    expect(adjust(closed, "networkIn", 1, true)).toMatchObject({ networkOut: "open", networkIn: "open" });
    expect(adjust(adjust(closed, "networkIn", 1, true), "networkIn", 1, true)).toMatchObject({ networkOut: "ask", networkIn: "closed" });
  });
});

const spec = (overrides: Partial<Spec> = {}): Spec => ({
  project: "/work/project",
  cwd: "/work/project",
  shell: "/bin/sh",
  command: "true",
  settings,
  credentialPaths: ["/home/me/.ssh"],
  lockedPaths: [],
  ...overrides,
});

describe("profiles", () => {
  test("seatbelt profile only opens the proxy port in ask mode", () => {
    const profile = seatbeltProfile(spec({ proxyPort: 4321 }));
    expect(profile).toContain('(remote ip "localhost:4321")');
    expect(profile).toContain("(deny network-outbound)");
    expect(profile).toContain('(deny network-bind (local ip "*:*"))');
    expect(seatbeltProfile(spec({ settings: { ...settings, networkOut: "open", networkIn: "open" } }))).not.toContain("network");
  });
  test("bwrap unshares the network unless open", () => {
    expect(bwrapArgs(spec())).toContain("--unshare-net");
    expect(bwrapArgs(spec({ settings: { ...settings, networkOut: "open" } }))).not.toContain("--unshare-net");
  });
});

describe("proxy", () => {
  test("CONNECT tunnels allowed hosts and refuses others", async () => {
    const upstream = createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as any).port;
    const seen: string[] = [];
    const proxy = await startProxy(async (target) => {
      seen.push(target);
      return target === `127.0.0.1:${port}`;
    });
    const roundTrip = (target: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
      });
    expect(await roundTrip(`127.0.0.1:${port}`)).toContain("200 Connection Established\r\n\r\nhello");
    expect(await roundTrip("blocked.example:443")).toContain("403");
    expect(seen).toEqual([`127.0.0.1:${port}`, "blocked.example:443"]);
    await proxy.close();
    upstream.close();
  });

  test("SOCKS5 asks with host:port", async () => {
    const seen: string[] = [];
    const proxy = await startProxy(async (target) => (seen.push(target), false));
    const reply = await new Promise<Buffer>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write(Buffer.from([5, 1, 0]));
        const host = Buffer.from("example.com");
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 187])]));
      });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks)));
    });
    expect(seen).toEqual(["example.com:443"]);
    expect(reply[3]).toBe(2);
    await proxy.close();
  });
});

describe.skipIf(process.platform !== "darwin")("seatbelt (live)", () => {
  test("blocks writes outside the project, credentials and direct network", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-"));
    const project = join(root, "project");
    const outside = join(root, "outside");
    const secret = join(root, "secret");
    for (const dir of [project, outside, secret]) mkdirSync(dir);
    writeFileSync(join(secret, "key"), "s3cret");
    const script = [
      `touch ${project}/ok && echo project-write=ok`,
      `touch ${outside}/no 2>/dev/null && echo outside-write=ok || echo outside-write=blocked`,
      `cat ${secret}/key 2>/dev/null || echo secret=blocked`,
      `curl -s -m 3 -o /dev/null https://example.com && echo net=ok || echo net=blocked`,
    ].join("; ");
    const command = seatbelt.wrap(
      spec({
        project,
        cwd: project,
        command: script,
        // The tmp dir is writable by default; this test's "outside" lives there, so drop it from the writable set.
        credentialPaths: [secret, outside],
      }),
    );
    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(result.stdout).toContain("project-write=ok");
    expect(result.stdout).toContain("outside-write=blocked");
    expect(result.stdout).toContain("secret=blocked");
    expect(result.stdout).toContain("net=blocked");
    expect(existsSync(join(outside, "no"))).toBe(false);
  });
});

describe("extends and homeLinks", () => {
  test("stripJsonc keeps strings and drops comments and trailing commas", () => {
    const text = '{\n // line\n "a": "x // not a comment", /* block */ "b": ["y",],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: "x // not a comment", b: ["y"] });
  });
  test("extends overrides inline options, and a missing file is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-ext-"));
    writeFileSync(join(dir, "extra.jsonc"), '// c\n{ "credentialPaths": ["~/.secret"], "homeLinks": ["~/.a"], }');
    const { options, warning } = resolveOptions({ extends: join(dir, "extra.jsonc"), credentialPaths: ["~/.old"], homeLinks: ["~/.x"] });
    expect(warning).toBeUndefined();
    expect(options).toMatchObject({ credentialPaths: ["~/.secret"], homeLinks: ["~/.a"] });
    expect(resolveOptions({ extends: join(dir, "missing.jsonc"), homeLinks: ["~/.x"] })).toMatchObject({ options: { homeLinks: ["~/.x"] } });
    writeFileSync(join(dir, "bad.jsonc"), "{ nope");
    expect(resolveOptions({ extends: join(dir, "bad.jsonc") }).warning).toContain("bad.jsonc");
  });
  test("homeLinks symlinks into the sandbox home, skipping credentials and outside paths", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "sbx-home-")));
    const sandboxHome = mkdtempSync(join(tmpdir(), "sbx-sandbox-"));
    mkdirSync(join(home, ".config", "containers"), { recursive: true });
    mkdirSync(join(home, ".ssh"));
    linkIntoHome(sandboxHome, ["~/.config/containers", "~/.ssh", "/etc", "~/.missing"], [join(home, ".ssh")], home);
    linkIntoHome(sandboxHome, ["~/.config/containers"], [], home);
    expect(readlinkSync(join(sandboxHome, ".config", "containers"))).toBe(join(home, ".config", "containers"));
    expect(existsSync(join(sandboxHome, ".ssh"))).toBe(false);
    expect(existsSync(join(sandboxHome, ".missing"))).toBe(false);
  });
});

describe("config lock", () => {
  test("is on by default, shows as a setting, and is never stored", () => {
    expect(settings.lockConfig).toBe(true);
    const row = adjust(settings, "lockConfig", 1);
    expect(row.lockConfig).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "sbx-lock-"));
    const savedState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-lock-state-"));
    try {
      saveProject({ directory: dir, settings: row, lists: { allow: [], deny: [] } });
      expect(JSON.parse(readFileSync(projectFile(dir), "utf8")).settings.lockConfig).toBeUndefined();
      expect(loadProject(dir, parseOptions({})).settings.lockConfig).toBe(true);
    } finally {
      if (savedState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedState;
    }
  });
  test("lockedPaths covers config, state, project config files and homeLinks targets", () => {
    const paths = lockedPaths("/work/project", ["~/.npmrc"]);
    expect(paths.some((path) => path.endsWith("/opencode"))).toBe(true);
    expect(paths.some((path) => path.endsWith("opencode-sandbox-mode"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/work/project/opencode.jsonc"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/.npmrc"))).toBe(true);
  });
  test("seatbelt denies writes after the project allow and re-allows the sandbox home", () => {
    const profile = seatbeltProfile(spec({ lockedPaths: ["/work/project/.config"], home: "/state/homes/x" }));
    const lines = profile.split("\n");
    const allow = lines.findIndex((line) => line.startsWith("(allow file-write*") && line.includes('"/work/project"'));
    const deny = lines.findIndex((line) => line.includes('(deny file-write* (subpath "/work/project/.config"))'));
    expect(deny).toBeGreaterThan(allow);
    expect(lines[deny + 1]).toContain('(allow file-write* (subpath "/state/homes/x"))');
    expect(seatbeltProfile(spec())).not.toContain(".config");
  });
  test("bwrap makes existing locked paths read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-bwrap-"));
    const args = bwrapArgs(spec({ project: dir, cwd: dir, lockedPaths: [dir] }));
    expect(args.join(" ")).toContain(`--ro-bind ${dir} ${dir}`);
    expect(args.lastIndexOf("--ro-bind")).toBeGreaterThan(args.indexOf("--bind"));
  });
  test("live: the shell can't write a locked folder, even inside the project", () => {
    if (process.platform !== "darwin" || process.env.OPENCODE_SANDBOX) return;
    const project = realpathSync(mkdtempSync(join(tmpdir(), "sbx-live-")));
    const config = join(project, "config");
    mkdirSync(config);
    const command = seatbelt.wrap(
      spec({
        project,
        cwd: project,
        shell: "/bin/sh",
        command: `touch ${project}/ok && echo project-write=ok; touch ${config}/nope 2>/dev/null && echo locked-write=ok`,
        lockedPaths: [config],
      }),
    );
    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(result.stdout).toContain("project-write=ok");
    expect(result.stdout).not.toContain("locked-write=ok");
  });
});

describe("sandboxMcp network", () => {
  test("proxied servers only reach the proxy; without one they get nothing", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-mcp-net-"));
    try {
      const context = { backend: seatbelt, credentialPaths: [], homeLinks: [], project: "/work/proj" };
      const proxied = sandboxServer("p", { type: "local", command: ["x"] }, { ...context, proxyPort: 4321 });
      const direct = sandboxServer("q", { type: "local", command: ["x"] }, context);
      if (!proxied.ok || !direct.ok) throw new Error("not wrapped");
      const profile = proxied.server.command![2]!;
      expect(profile).toContain('(remote ip "localhost:4321")');
      expect(profile).toContain("(deny network-outbound)");
      expect(profile).not.toContain('(remote ip "localhost:*")');
      expect(proxied.server.environment).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:4321", ALL_PROXY: "socks5h://127.0.0.1:4321", NO_PROXY: "", NODE_USE_ENV_PROXY: "1" });
      expect(direct.server.command![2]).not.toContain("localhost:");
      expect(direct.server.environment).not.toHaveProperty("HTTPS_PROXY");
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
});

describe("sandboxMcp", () => {
  test("entries are names or objects with args", () => {
    expect(parseOptions({ sandboxMcp: ["a*", { name: "b", args: ["--x", 1] }, { args: [] }, 3] }).sandboxMcp).toEqual([
      { name: "a*", args: [] },
      { name: "b", args: ["--x"] },
    ]);
  });
  test("names match with * and ignore case", () => {
    expect(matchesName("dummy-everything", ["dummy-everything*"])).toBe(true);
    expect(matchesName("Dummy-Everything-extra", ["dummy-everything*"])).toBe(true);
    expect(matchesName("dummy-everything", ["dummy-everything-*"])).toBe(false);
    expect(matchesName("github", ["dummy-everything*"])).toBe(false);
    expect(matchesName("a.b", ["a.b"])).toBe(true);
    expect(matchesName("axb", ["a.b"])).toBe(false);
  });
  test("a local server is wrapped, with its own HOME; remote ones are left alone", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-mcp-"));
    try {
      const context = { backend: seatbelt, credentialPaths: ["/home/me/.ssh"], homeLinks: [], project: "/work/proj" };
      const result = sandboxServer("dummy-everything", { type: "local", command: ["npx", "@modelcontextprotocol/server-everything"], environment: { A: "1" } }, context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [exec, flag, profile, ...rest] = result.server.command!;
      expect(exec).toBe("/usr/bin/sandbox-exec");
      expect(flag).toBe("-p");
      expect(profile).toContain("(deny file-write*)");
      expect(profile).toContain("/home/me/.ssh");
      expect(rest).toEqual(["npx", "@modelcontextprotocol/server-everything"]);
      const withArgs = sandboxServer("dummy-everything", { type: "local", command: ["npx", "x"] }, { ...context, args: ["--no-sandbox"] });
      if (withArgs.ok) expect(withArgs.server.command!.slice(-3)).toEqual(["npx", "x", "--no-sandbox"]);
      expect(result.server.environment).toMatchObject({ A: "1", OPENCODE_SANDBOX: "seatbelt" });
      expect(result.server.environment!.HOME).toBe(result.server.cwd!);
      expect(result.server.environment!.HOME).toContain("opencode-sandbox-mode/mcp/dummy-everything/");
      expect(result.server.environment!.HOME.endsWith(projectHash("/work/proj"))).toBe(true);
      expect(sandboxServer("x", result.server, context)).toMatchObject({ ok: true, server: result.server });
      expect(sandboxServer("remote", { type: "remote" }, context)).toMatchObject({ ok: false });
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
  test("live: a wrapped program can't write outside its folder", () => {
    if (process.platform !== "darwin" || process.env.OPENCODE_SANDBOX) return;
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = realpathSync(mkdtempSync(join(tmpdir(), "sbx-mcp-live-")));
    try {
      const outside = realpathSync(mkdtempSync(join(process.env.HOME ?? "/Users", ".sbx-outside-")));
      const result = sandboxServer("live", { type: "local", command: ["/bin/sh", "-c", `touch "$HOME/ok" && echo home=ok; touch ${outside}/nope 2>/dev/null && echo outside=ok`] }, { backend: seatbelt, credentialPaths: [], homeLinks: [], project: "/work/proj" });
      if (!result.ok) throw new Error(result.reason);
      const [program, ...args] = result.server.command!;
      const run = spawnSync(program!, args, { encoding: "utf8", env: { ...process.env, ...result.server.environment }, cwd: result.server.cwd });
      spawnSync("rmdir", [outside]);
      expect(run.stdout).toContain("home=ok");
      expect(run.stdout).not.toContain("outside=ok");
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
});

describe("remove sandbox files", () => {
  test("deletes the home and the saved state of one project, and keeps symlink targets and other projects", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-rm-"));
    try {
      const outside = mkdtempSync(join(tmpdir(), "sbx-rm-target-"));
      writeFileSync(join(outside, "npmrc"), "min-release-age=2\n");
      const [a, b] = ["/work/a", "/work/b"];
      for (const directory of [a!, b!]) {
        mkdirSync(join(homeDir(directory), ".cache"), { recursive: true });
        saveProject({ directory, settings: settings, lists: { allow: ["^x$"], deny: [] } });
      }
      symlinkSync(join(outside, "npmrc"), join(homeDir(a!), ".npmrc"));
      expect(hasProjectFiles(a!)).toBe(true);

      removeProjectFiles(a!);

      expect(hasProjectFiles(a!)).toBe(false);
      expect(existsSync(homeDir(a!))).toBe(false);
      expect(existsSync(projectFile(a!))).toBe(false);
      expect(readFileSync(join(outside, "npmrc"), "utf8")).toContain("min-release-age=2");
      expect(hasProjectFiles(b!)).toBe(true);
      expect(loadProject(b!, parseOptions({})).lists.allow).toEqual(["^x$"]);
      expect(() => removeProjectFiles(a!)).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
  test("the rows are the last ones and not settings", () => {
    expect(SETTING_ROWS.at(-2)).toMatchObject({ key: "removeFiles", label: "Remove sandbox files for this project" });
    expect(SETTING_ROWS.at(-1)).toMatchObject({ key: "sandboxes", label: "List all sandboxes" });
    expect("removeFiles" in settings).toBe(false);
  });
  test("the description does not mention when the row is available", () => {
    expect(SETTING_ROWS.at(-2)?.description).not.toMatch(/only shown|hidden/i);
  });
});

describe("list all sandboxes", () => {
  const withState = <T,>(run: () => T): T => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-list-"));
    try {
      return run();
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  };
  const make = (directory: string, enabled = false, allow = ["^x$"]) => {
    mkdirSync(homeDir(directory), { recursive: true });
    saveProject({ directory, settings: { ...settings, enabled }, lists: { allow, deny: [] } });
  };

  test("lists projects, marks missing folders, and finds leftover homes without a settings file", () =>
    withState(() => {
      const there = realpathSync(mkdtempSync(join(tmpdir(), "sbx-there-")));
      make(there);
      make("/gone/project", true, ["^a$", "^b$"]);
      mkdirSync(join(process.env.XDG_STATE_HOME!, "opencode-sandbox-mode", "homes", "0123456789abcdef"), { recursive: true });
      const list = listSandboxes({ pid: process.pid, current: there });
      expect(list).toHaveLength(3);
      const byDir = (directory: string | null) => list.find((info) => info.directory === directory)!;
      expect(byDir(there)).toMatchObject({ exists: true, enabled: false, live: false, current: true, allow: 1, hasHome: true });
      expect(byDir("/gone/project")).toMatchObject({ exists: false, enabled: true, live: false, allow: 2 });
      expect(byDir(null)).toMatchObject({ hash: "0123456789abcdef", exists: false, hasHome: true });
      // In use first, then missing folders, then the rest.
      expect(list.map((info) => info.directory)).toEqual(["/gone/project", null, there]);
    }));

  test("a project is live only with a fresh heartbeat of a running process", () =>
    withState(() => {
      const [a, b, c] = ["/work/a", "/work/b", "/work/c"] as const;
      for (const directory of [a, b, c]) make(directory, true);
      writeLive(process.pid, [a]);
      writeLive(process.ppid, [b]);
      expect(listSandboxes({ pid: process.pid }).map((info) => [info.directory, info.here, info.elsewhere, info.live])).toEqual([
        [a, true, false, true],
        [b, false, true, true],
        [c, false, false, false],
      ]);
      // A stale heartbeat and a dead process don't count, and their files are cleaned up.
      writeLive(process.ppid, [b], Date.now() - FRESH_MS - 1000);
      expect(readLive().has(b)).toBe(false);
      const dead = Bun.spawnSync(["true"]).pid;
      writeLive(dead, [c]);
      expect(readLive().has(c)).toBe(false);
      removeLive(process.pid);
      expect(readLive().size).toBe(0);
    }));

  test("wiping by hash removes one sandbox only", () =>
    withState(() => {
      make("/work/a");
      make("/work/b");
      removeProjectFilesByHash(projectHash("/work/a"));
      expect(listSandboxes({ pid: process.pid }).map((info) => info.directory)).toEqual(["/work/b"]);
      expect(() => removeProjectFilesByHash(projectHash("/work/a"))).not.toThrow();
    }));
});

describe("MCP access to the project", () => {
  const wrap = (projectWrite: boolean) => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-mcp-proj-"));
    try {
      const result = sandboxServer("srv", { type: "local", command: ["x"] }, { backend: seatbelt, credentialPaths: [], homeLinks: [], project: "/work/proj", projectWrite });
      if (!result.ok) throw new Error(result.reason);
      return result.server;
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  };
  test("by default a server only writes its own folder and starts there", () => {
    const server = wrap(false);
    const profile = server.command![2]!;
    expect(profile).toContain("(deny file-write*)");
    const allow = profile.split("\n").find((line) => line.startsWith("(allow file-write*"))!;
    expect(allow).not.toContain('"/work/proj"');
    expect(allow).toContain(server.environment!.HOME);
    expect(server.cwd).toBe(server.environment!.HOME);
  });
  test("with project write the project is writable and the server starts in it, with git and OpenCode config read-only", () => {
    const server = wrap(true);
    const profile = server.command![2]!;
    const lines = profile.split("\n");
    const allow = lines.find((line) => line.startsWith("(allow file-write*"))!;
    expect(allow).toContain('"/work/proj"');
    expect(allow).toContain(server.environment!.HOME);
    expect(server.cwd).toBe("/work/proj");
    expect(profile).toContain('(subpath "/work/proj/.git/hooks")');
    expect(profile).toContain('(subpath "/work/proj/opencode.jsonc")');
    expect(profile).toContain('(subpath "/work/proj/.opencode")');
    // The server's own folder (inside the locked state folder) stays writable.
    expect(lines[lines.findIndex((line) => line.includes("(deny file-write* (subpath") && line.includes("/work/proj/opencode.jsonc")) + 1]).toContain(server.environment!.HOME);
  });
  test("the setting is a per-project boolean row, off by default", () => {
    expect(settings.mcpProjectWrite).toBe(false);
    expect(SETTING_ROWS.some((row) => row.key === "mcpProjectWrite")).toBe(true);
    expect(adjust(settings, "mcpProjectWrite", 1).mcpProjectWrite).toBe(true);
  });
  test("wiping a project also removes its MCP server folders, and only those", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "sbx-mcp-wipe-"));
    try {
      const a = sandboxServer("one", { type: "local", command: ["x"] }, { backend: seatbelt, credentialPaths: [], homeLinks: [], project: "/work/a" });
      const b = sandboxServer("one", { type: "local", command: ["x"] }, { backend: seatbelt, credentialPaths: [], homeLinks: [], project: "/work/b" });
      if (!a.ok || !b.ok) throw new Error("not wrapped");
      expect(listSandboxes({ pid: process.pid }).map((info) => info.hash).sort()).toEqual([projectHash("/work/a"), projectHash("/work/b")].sort());
      removeProjectFilesByHash(projectHash("/work/a"));
      expect(existsSync(a.server.environment!.HOME!)).toBe(false);
      expect(existsSync(b.server.environment!.HOME!)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
});
