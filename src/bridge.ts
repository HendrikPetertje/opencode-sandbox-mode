/**
 * Linux "ask" mode: bubblewrap gives the sandbox its own network namespace, so
 * the host's proxy port isn't reachable from inside. The proxy also listens on
 * a unix socket that is bind-mounted into the sandbox, and a small forwarder
 * inside the sandbox turns 127.0.0.1:<port> into connections to that socket.
 * The forwarder runs on whichever interpreter the machine has: python3 or node.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where the bridge folder (socket and forwarder) appears inside the sandbox; /tmp is a fresh tmpfs there. */
export const BRIDGE_MOUNT = "/tmp/.opencode-sandbox";
export const BRIDGE_SOCKET = "proxy.sock";

const PYTHON = `import os, socket, sys, threading
path, port, ready = sys.argv[1], int(sys.argv[2]), sys.argv[3]
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen(128)
open(ready, "w").close()

def pipe(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def handle(client):
    upstream = socket.socket(socket.AF_UNIX)
    try:
        upstream.connect(path)
    except OSError:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)
    client.close()
    upstream.close()

while True:
    client, _ = server.accept()
    threading.Thread(target=handle, args=(client,), daemon=True).start()
`;

const NODE = `const net = require("node:net");
const fs = require("node:fs");
const [path, port, ready] = process.argv.slice(2);
net
  .createServer((client) => {
    const upstream = net.connect(path);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  })
  .listen(Number(port), "127.0.0.1", () => fs.writeFileSync(ready, ""));
`;

export interface Forwarder {
  interpreter: string;
  file: string;
  source: string;
}

let found: Forwarder | null | undefined;

/** The first interpreter on this machine that can run the forwarder, or undefined. */
export function findForwarder(): Forwarder | undefined {
  if (found !== undefined) return found ?? undefined;
  for (const [name, file, source] of [
    ["python3", "forward.py", PYTHON],
    ["node", "forward.cjs", NODE],
  ] as const) {
    const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", timeout: 3000 });
    const interpreter = result.stdout?.trim();
    if (result.status === 0 && interpreter) {
      found = { interpreter, file, source };
      return found;
    }
  }
  found = null;
  return undefined;
}

/** Writes the forwarder next to the socket, so one bind mount brings both into the sandbox. */
export function prepareBridge(dir: string, forwarder: Forwarder): void {
  writeFileSync(join(dir, forwarder.file), forwarder.source);
}

/**
 * Starts the forwarder inside the sandbox and waits (up to 5s) until it listens, then runs the command.
 * `$0` is the user's shell and `$1` the command, so neither needs quoting here.
 */
export function bridgePrelude(forwarder: Forwarder, port: number): string {
  const ready = `/tmp/.opencode-sandbox-ready-$$`;
  return [
    `${forwarder.interpreter} ${BRIDGE_MOUNT}/${forwarder.file} ${BRIDGE_MOUNT}/${BRIDGE_SOCKET} ${port} ${ready} >/dev/null 2>&1 &`,
    `i=0; while [ ! -e ${ready} ] && [ $i -lt 500 ]; do sleep 0.01; i=$((i+1)); done`,
    `rm -f ${ready}`,
    `exec "$0" -c "$1"`,
  ].join("\n");
}
