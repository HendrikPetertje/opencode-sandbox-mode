import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, seatbelt, seatbeltProfile, type Spec } from "./backend.ts";
import { adjust, parseOptions } from "./options.ts";
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
});

const spec = (overrides: Partial<Spec> = {}): Spec => ({
  project: "/work/project",
  cwd: "/work/project",
  shell: "/bin/sh",
  command: "true",
  settings,
  credentialPaths: ["/home/me/.ssh"],
  extraReadPaths: [],
  extraWritePaths: [],
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
