/**
 * A small forward proxy for "ask" mode. The sandbox only lets commands reach
 * this proxy, and the proxy decides per `host:port`: HTTP CONNECT (https),
 * plain HTTP with an absolute URL, and SOCKS5 (for ALL_PROXY users).
 */
import { rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

export type Decide = (target: string) => Promise<boolean>;

export interface Proxy {
  port: number;
  close(): Promise<void>;
}

const HEADER_LIMIT = 64 * 1024;

function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } | undefined {
  const bracket = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) return { host: bracket[1]!, port: Number(bracket[2] ?? fallbackPort) };
  const index = value.lastIndexOf(":");
  if (index > 0 && value.indexOf(":") === index) return { host: value.slice(0, index), port: Number(value.slice(index + 1)) };
  return value ? { host: value, port: fallbackPort } : undefined;
}

const targetOf = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

function tunnel(client: Socket, host: string, port: number, onOpen: (upstream: Socket) => void, onFail: () => void): void {
  const upstream = connect({ host, port });
  upstream.once("connect", () => {
    onOpen(upstream);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.once("error", () => {
    onFail();
    client.destroy();
  });
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
}

async function handleHttp(client: Socket, head: Buffer, decide: Decide): Promise<void> {
  const end = head.indexOf("\r\n\r\n");
  const headerText = head.subarray(0, end).toString("latin1");
  const rest = head.subarray(end + 4);
  const [requestLine, ...headers] = headerText.split("\r\n");
  const [method, uri, version] = (requestLine ?? "").split(" ");
  const refuse = (status: string) => {
    client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nopencode sandbox: ${status}\n`);
  };

  if (method === "CONNECT") {
    const parsed = splitHostPort(uri ?? "", 443);
    if (!parsed) return refuse("400 Bad Request");
    if (!(await decide(targetOf(parsed.host, parsed.port)))) return refuse("403 Forbidden");
    tunnel(
      client,
      parsed.host,
      parsed.port,
      (upstream) => {
        client.write(`${version ?? "HTTP/1.1"} 200 Connection Established\r\n\r\n`);
        if (rest.length > 0) upstream.write(rest);
      },
      () => refuse("502 Bad Gateway"),
    );
    return;
  }

  let url: URL;
  try {
    url = new URL(uri ?? "");
  } catch {
    return refuse("400 Bad Request");
  }
  if (url.protocol !== "http:") return refuse("400 Bad Request");
  const port = Number(url.port || 80);
  if (!(await decide(targetOf(url.hostname.replace(/^\[|\]$/g, ""), port)))) return refuse("403 Forbidden");
  // One host per client connection: ask the client to reconnect for the next request.
  const kept = headers.filter((line) => !/^(proxy-connection|connection|keep-alive):/i.test(line));
  const request = [`${method} ${url.pathname}${url.search} ${version}`, ...kept, "Connection: close", "", ""].join("\r\n");
  tunnel(
    client,
    url.hostname.replace(/^\[|\]$/g, ""),
    port,
    (upstream) => {
      upstream.write(request);
      if (rest.length > 0) upstream.write(rest);
    },
    () => refuse("502 Bad Gateway"),
  );
}

/** SOCKS5, no authentication, CONNECT only. */
function handleSocks(client: Socket, first: Buffer, decide: Decide): void {
  let buffer = first;
  let stage: "greeting" | "request" | "done" = "greeting";
  const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
  const onData = async (chunk?: Buffer) => {
    if (chunk) buffer = Buffer.concat([buffer, chunk]);
    if (stage === "greeting") {
      if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
      buffer = buffer.subarray(2 + buffer[1]!);
      client.write(Buffer.from([5, 0]));
      stage = "request";
    }
    if (stage !== "request" || buffer.length < 5) return;
    const [, command, , type] = buffer;
    let host: string;
    let offset: number;
    if (type === 1) {
      if (buffer.length < 10) return;
      host = [...buffer.subarray(4, 8)].join(".");
      offset = 8;
    } else if (type === 3) {
      const length = buffer[4]!;
      if (buffer.length < 5 + length + 2) return;
      host = buffer.subarray(5, 5 + length).toString("latin1");
      offset = 5 + length;
    } else if (type === 4) {
      if (buffer.length < 22) return;
      const parts: string[] = [];
      for (let i = 4; i < 20; i += 2) parts.push(buffer.readUInt16BE(i).toString(16));
      host = parts.join(":");
      offset = 20;
    } else {
      stage = "done";
      return void client.end(reply(8));
    }
    const port = buffer.readUInt16BE(offset);
    const rest = buffer.subarray(offset + 2);
    stage = "done";
    client.off("data", onData);
    client.pause();
    if (command !== 1) return void client.end(reply(7));
    if (!(await decide(targetOf(host, port)))) return void client.end(reply(2));
    tunnel(
      client,
      host,
      port,
      (upstream) => {
        client.write(reply(0));
        if (rest.length > 0) upstream.write(rest);
      },
      () => client.end(reply(5)),
    );
  };
  client.on("data", onData);
  void onData();
}

/**
 * Listens on a random 127.0.0.1 port, and also on `unixPath` when given: on
 * Linux the sandbox has its own network namespace and reaches the proxy
 * through that socket (see bridge.ts).
 */
export function startProxy(decide: Decide, unixPath?: string): Promise<Proxy> {
  const sockets = new Set<Socket>();
  const handler = (client: Socket) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head[0] === 5) {
        client.off("data", onData);
        return handleSocks(client, head, decide);
      }
      if (head.indexOf("\r\n\r\n") !== -1) {
        client.off("data", onData);
        client.pause();
        void handleHttp(client, head, decide);
        return;
      }
      if (head.length > HEADER_LIMIT) client.destroy();
    };
    client.on("data", onData);
  };
  const listen = (server: Server, ...args: unknown[]) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      (server.listen as any)(...args, () => resolve());
    });
  const tcp: Server = createServer(handler);
  const unix: Server | undefined = unixPath ? createServer(handler) : undefined;
  return (async () => {
    await listen(tcp, 0, "127.0.0.1");
    if (unix && unixPath) {
      rmSync(unixPath, { force: true });
      await listen(unix, unixPath);
    }
    const address = tcp.address();
    const close = (server: Server) => new Promise<void>((done) => server.close(() => done()));
    return {
      port: typeof address === "object" && address ? address.port : 0,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await Promise.all([close(tcp), unix ? close(unix) : undefined]);
        if (unixPath) rmSync(unixPath, { force: true });
      },
    };
  })();
}
