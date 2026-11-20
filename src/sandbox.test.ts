import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, seatbelt, seatbeltProfile, type Spec } from "./backend.ts";
import { adjust, parseOptions, resolveOptions, stripJsonc } from "./options.ts";
import { linkIntoHome, lockedPaths } from "./paths.ts";
import { loadProject, projectFile, saveProject } from "./state.ts";
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
    const state = { directory: dir, settings: row, lists: { allow: [], deny: [] } };
    saveProject(state);
    expect(JSON.parse(readFileSync(projectFile(dir), "utf8")).settings.lockConfig).toBeUndefined();
    expect(loadProject(dir, parseOptions({})).settings.lockConfig).toBe(true);
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
