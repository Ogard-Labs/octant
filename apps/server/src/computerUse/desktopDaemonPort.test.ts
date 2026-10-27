import { execFile } from "node:child_process";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopDaemonRequest } from "@octant/plugin-api/desktop-provider";
import { createDesktopDaemonPort, type DesktopDaemonPortOptions } from "./desktopDaemonPort";

const userId = process.getuid?.() ?? 0;
const SOCKET = ".cua/cua.sock";
const METHODS = [
  "/test.daemon.v1.SpaceService/CreateSpace",
  "/test.daemon.v1.SpaceService/Fail",
  "/test.daemon.v1.SpaceService/Hang",
  "/test.daemon.v1.SpaceService/Answer",
  "/v1/spaces/*/env/test.env.v1.ComputerService/Screenshot",
];

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: Uint8Array;
}

const frame = (flag: number, payload: Uint8Array): Uint8Array => {
  const framed = new Uint8Array(5 + payload.byteLength);
  framed[0] = flag;
  new DataView(framed.buffer).setUint32(1, payload.byteLength);
  framed.set(payload, 5);
  return framed;
};
const trailer = (text: string) => frame(0x80, new TextEncoder().encode(text));
const joined = (...parts: ReadonlyArray<Uint8Array>) => Buffer.concat(parts);

/** What the test daemon answers for a request path; the default echoes the message. */
type Answer = (request: Seen, response: ServerResponse) => void;

const echo: Answer = (request, response) => {
  response.writeHead(200, { "content-type": "application/grpc-web+proto" });
  response.end(joined(frame(0, request.body.subarray(5)), trailer("grpc-status: 0\r\n")));
};

const homes: Array<string> = [];
const servers: Array<Server> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * A home directory with a real test daemon listening on `socket` under it
 * (`.cua/cua.sock` unless given), mode 0600 as Cua's daemon sets it. It
 * speaks just enough gRPC-Web over HTTP/1.1 to answer the port.
 */
async function daemonHome(answers: Readonly<Record<string, Answer>> = {}, socket = SOCKET) {
  const home = mkdtempSync(join(tmpdir(), "octant-daemon-"));
  homes.push(home);
  mkdirSync(join(home, dirname(socket)), { mode: 0o700 });
  const seen: Array<Seen> = [];
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: new Uint8Array(Buffer.concat(chunks)),
      };
      seen.push(entry);
      // Own keys only: a path such as `/constructor` must not reach a method
      // every object inherits.
      const url = request.url ?? "";
      const answer = Object.hasOwn(answers, url) ? answers[url] : undefined;
      (answer ?? echo)(entry, response);
    });
  });
  servers.push(server);
  const socketPath = join(home, socket);
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  chmodSync(socketPath, 0o600);
  const port = (overrides: Partial<DesktopDaemonPortOptions> = {}) =>
    createDesktopDaemonPort({
      daemon: () => ({ socketPath: socket, methods: METHODS }),
      homeDirectory: home,
      userId,
      ...overrides,
    });
  return { home, socketPath, seen, port };
}

const message = new Uint8Array([0x0a, 0x03, 0x61, 0x62, 0x63]);
const call = (method: string, extra: Partial<DesktopDaemonRequest> = {}): DesktopDaemonRequest => ({
  method,
  message,
  maxResponseBytes: 1_024,
  ...extra,
});
const CREATE = "/test.daemon.v1.SpaceService/CreateSpace";

/**
 * One call through a port that finds the home itself, made while `HOME` is
 * `home` or unset. Bun reads `HOME` once, from the environment it was
 * launched with (observed on Bun 1.4.4), so under Bun the call is made by a
 * Bun launched with it; Node reads it live, so under Node it is set here.
 */
async function callWithHome(home: string | undefined, socketPath: string): Promise<unknown> {
  const declaration = { socketPath, methods: [CREATE] };
  const request = { method: CREATE, message: [], maxResponseBytes: 1_024 };
  if (process.versions.bun === undefined) {
    vi.stubEnv("HOME", home);
    try {
      const port = createDesktopDaemonPort({ daemon: () => declaration });
      return await port.call({ ...request, message: new Uint8Array(request.message) });
    } finally {
      vi.unstubAllEnvs();
    }
  }
  const environment = { ...process.env };
  delete environment.HOME;
  if (home !== undefined) environment.HOME = home;
  const script = [
    `const { createDesktopDaemonPort } = await import(${JSON.stringify(fileURLToPath(new URL("./desktopDaemonPort.ts", import.meta.url)))});`,
    `const port = createDesktopDaemonPort({ daemon: () => (${JSON.stringify(declaration)}) });`,
    `const request = ${JSON.stringify(request)};`,
    "const result = await port.call({ ...request, message: new Uint8Array(request.message) });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const output = await new Promise<string>((settle, reject) =>
    execFile(process.execPath, ["-e", script], { env: environment }, (error, stdout) =>
      error === null ? settle(stdout) : reject(error),
    ),
  );
  const result: unknown = JSON.parse(output);
  return result;
}

describe("desktop daemon port", () => {
  it("answers a declared call over gRPC-Web on the daemon's Unix socket, writing every header itself", async () => {
    const { port, seen } = await daemonHome();
    await expect(port().call(call(CREATE))).resolves.toEqual({
      status: "answered",
      grpcStatus: 0,
      grpcMessage: "",
      message,
      messages: [message],
    });
    await expect(
      port().call(call("/v1/spaces/space-1.key_~x/env/test.env.v1.ComputerService/Screenshot")),
    ).resolves.toMatchObject({ status: "answered", grpcStatus: 0 });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe(CREATE);
    expect(seen[0]?.body).toEqual(new Uint8Array(frame(0, message)));
    expect(seen[0]?.headers["content-type"]).toBe("application/grpc-web+proto");
    expect(seen[0]?.headers["grpc-timeout"]).toBe("45000m");
    // Only the host's own headers and the transport's framing reach the daemon.
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual([
      "connection",
      "content-length",
      "content-type",
      "grpc-timeout",
      "host",
    ]);
  });

  it("answers a gRPC error as a value with the daemon's status and message", async () => {
    const { port } = await daemonHome({
      "/test.daemon.v1.SpaceService/Fail": (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.end(trailer("grpc-status: 5\r\ngrpc-message: space%20not%20found\r\n"));
      },
    });
    await expect(port().call(call("/test.daemon.v1.SpaceService/Fail"))).resolves.toEqual({
      status: "answered",
      grpcStatus: 5,
      grpcMessage: "space not found",
      message: new Uint8Array(0),
      messages: [],
    });
  });

  it("reads a status the daemon sends in the response headers with no body", async () => {
    const { port } = await daemonHome({
      "/test.daemon.v1.SpaceService/Fail": (_request, response) => {
        response.writeHead(200, {
          "content-type": "application/grpc-web+proto",
          "grpc-status": "12",
          "grpc-message": "unimplemented",
        });
        response.end();
      },
    });
    await expect(port().call(call("/test.daemon.v1.SpaceService/Fail"))).resolves.toEqual({
      status: "answered",
      grpcStatus: 12,
      grpcMessage: "unimplemented",
      message: new Uint8Array(0),
      messages: [],
    });
  });

  it.each([
    "/test.daemon.v1.DaemonService/Shutdown",
    "/test.daemon.v1.SpaceService/CallSpaceTool",
    "/test.daemon.v1.SpaceService/CreateSpace/extra",
    "/test.daemon.v1.SpaceService/CreateSpace?x=1",
    "test.daemon.v1.SpaceService/CreateSpace",
    "/v1/spaces/../env/test.env.v1.ComputerService/Screenshot",
    "/v1/spaces/a/b/env/test.env.v1.ComputerService/Screenshot",
    "/v1/spaces//env/test.env.v1.ComputerService/Screenshot",
    "/v1/spaces/a%2Fb/env/test.env.v1.ComputerService/Screenshot",
    "/mcp",
  ])("refuses the undeclared method %s before connecting", async (method) => {
    const { port, seen } = await daemonHome();
    await expect(port().call(call(method))).resolves.toEqual({
      status: "refused",
      reason: "method-not-declared",
    });
    expect(seen).toEqual([]);
  });

  it("declares nothing with a method pattern that has two wildcards or an empty segment", async () => {
    const { port, seen } = await daemonHome();
    const loose = port({
      daemon: () => ({ socketPath: SOCKET, methods: ["/*/*", "/test.daemon.v1.SpaceService//"] }),
    });
    await expect(loose.call(call("/a/b"))).resolves.toEqual({
      status: "refused",
      reason: "method-not-declared",
    });
    await expect(loose.call(call("/test.daemon.v1.SpaceService//"))).resolves.toEqual({
      status: "refused",
      reason: "method-not-declared",
    });
    expect(seen).toEqual([]);
  });

  it("refuses a socket that is a symlink, even to the real daemon", async () => {
    const { home, socketPath, port, seen } = await daemonHome();
    renameSync(socketPath, join(home, ".cua", "real.sock"));
    symlinkSync(join(home, ".cua", "real.sock"), socketPath);
    await expect(port().call(call(CREATE))).resolves.toEqual({
      status: "refused",
      reason: "socket-unsafe",
    });
    expect(seen).toEqual([]);
  });

  it("refuses a socket whose directory is a symlink", async () => {
    const { home, port, seen } = await daemonHome();
    renameSync(join(home, ".cua"), join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(home, ".cua"));
    await expect(port().call(call(CREATE))).resolves.toEqual({
      status: "refused",
      reason: "socket-unsafe",
    });
    expect(seen).toEqual([]);
  });

  it.each([0o660, 0o640, 0o606, 0o601, 0o610])(
    "refuses a socket with mode %o, which another user could reach",
    async (mode) => {
      const { socketPath, port, seen } = await daemonHome();
      chmodSync(socketPath, mode);
      await expect(port().call(call(CREATE))).resolves.toEqual({
        status: "refused",
        reason: "socket-unsafe",
      });
      expect(seen).toEqual([]);
    },
  );

  it.each([
    [".cua", 0o777],
    [".cua", 0o720],
    [".cua", 0o702],
    ["", 0o770],
  ])(
    "refuses a socket under %s when another user can write it (mode %o)",
    async (directory, mode) => {
      const { home, port, seen } = await daemonHome();
      chmodSync(join(home, directory), mode);
      await expect(port().call(call(CREATE))).resolves.toEqual({
        status: "refused",
        reason: "socket-unsafe",
      });
      expect(seen).toEqual([]);
    },
  );

  it("refuses a socket and directories that belong to another user", async () => {
    const { port, seen } = await daemonHome();
    await expect(port({ userId: userId + 1 }).call(call(CREATE))).resolves.toEqual({
      status: "refused",
      reason: "socket-unsafe",
    });
    expect(seen).toEqual([]);
  });

  // Giving a file to another user takes root. CI runs unprivileged and the
  // case above covers it there through the directories' owner as well.
  it.runIf(userId === 0)(
    "refuses a socket another user owns in Octant's user's own directory",
    async () => {
      const { socketPath, port, seen } = await daemonHome();
      chownSync(socketPath, 4_242, 4_242);
      await expect(port().call(call(CREATE))).resolves.toEqual({
        status: "refused",
        reason: "socket-unsafe",
      });
      expect(seen).toEqual([]);
    },
  );

  it.runIf(userId === 0)(
    "refuses Octant's user's socket in a directory another user owns",
    async () => {
      const { home, port, seen } = await daemonHome();
      chownSync(join(home, ".cua"), 4_242, 4_242);
      await expect(port().call(call(CREATE))).resolves.toEqual({
        status: "refused",
        reason: "socket-unsafe",
      });
      expect(seen).toEqual([]);
    },
  );

  it.each(["/tmp/cua.sock", "../cua.sock", ".cua/../.cua/cua.sock", "./.cua/cua.sock", ""])(
    "refuses a declared socket path %j that is not plainly under the home directory",
    async (socketPath) => {
      const { port, seen } = await daemonHome();
      await expect(
        port({ daemon: () => ({ socketPath, methods: METHODS }) }).call(call(CREATE)),
      ).resolves.toEqual({ status: "refused", reason: "socket-unsafe" });
      expect(seen).toEqual([]);
    },
  );

  it("answers a missing socket as the daemon being unreachable", async () => {
    const { socketPath, port } = await daemonHome();
    rmSync(socketPath);
    await expect(port().call(call(CREATE))).resolves.toEqual({
      status: "failed",
      reason: "daemon-unreachable",
    });
  });

  it("walks from the home the user database records, whether HOME points elsewhere or is unset", async () => {
    // A path no real home has, so the walk from the real one never reaches a daemon.
    const socket = ".octant-daemon-port-test/daemon.sock";
    const { home, seen } = await daemonHome({}, socket);
    const elsewhere = await callWithHome(home, socket);
    const unset = await callWithHome(undefined, socket);
    expect(elsewhere).not.toMatchObject({ status: "answered" });
    expect(elsewhere).toEqual(unset);
    expect(seen).toEqual([]);
  });

  it("refuses when the user database has no record of Octant's user", async () => {
    const unrecorded = createDesktopDaemonPort({
      daemon: () => ({ socketPath: SOCKET, methods: METHODS }),
      userId: 2_000_000_001,
    });
    await expect(unrecorded.call(call(CREATE))).resolves.toEqual({
      status: "refused",
      reason: "socket-unsafe",
    });
  });

  it("refuses headers from the driver, the caller identities the daemon trusts included", async () => {
    const { port, seen } = await daemonHome();
    for (const headers of [
      { "x-cua-host-caller": "relay-verified" },
      { "x-cua-share-caller": "relay-verified" },
      { "content-type": "application/grpc-web-text" },
      { authorization: "Bearer token" },
    ]) {
      // A driver that is not type-checked, such as an outside one, can still send any shape.
      const request: DesktopDaemonRequest = Object.assign(call(CREATE), { headers });
      await expect(port().call(request)).resolves.toEqual({
        status: "refused",
        reason: "request-invalid",
      });
    }
    const notBytes: DesktopDaemonRequest = Object.assign(call(CREATE), { message: "abc" });
    await expect(port().call(notBytes)).resolves.toEqual({
      status: "refused",
      reason: "request-invalid",
    });
    const nothing: DesktopDaemonRequest = JSON.parse("null");
    await expect(port().call(nothing)).resolves.toEqual({
      status: "refused",
      reason: "request-invalid",
    });
    expect(seen).toEqual([]);
  });

  it("refuses a message over 4 MiB before connecting", async () => {
    const { port, seen } = await daemonHome();
    await expect(
      port().call(call(CREATE, { message: new Uint8Array(4 * 1_048_576 + 1) })),
    ).resolves.toEqual({ status: "refused", reason: "request-too-large" });
    expect(seen).toEqual([]);
    await expect(
      port().call(call(CREATE, { message: new Uint8Array(4 * 1_048_576) })),
    ).resolves.toMatchObject({ status: "failed", reason: "response-too-large" });
  });

  it("stops reading a response past the bound the call named, and past the host's own", async () => {
    const big: Answer = (_request, response) => {
      response.writeHead(200, { "content-type": "application/grpc-web+proto" });
      response.end(joined(frame(0, new Uint8Array(4_096)), trailer("grpc-status: 0\r\n")));
    };
    const { port } = await daemonHome({ "/test.daemon.v1.SpaceService/Answer": big });
    await expect(port().call(call("/test.daemon.v1.SpaceService/Answer"))).resolves.toEqual({
      status: "failed",
      reason: "response-too-large",
    });
    await expect(
      port({ maxResponseBytes: 1_024 }).call(
        call("/test.daemon.v1.SpaceService/Answer", { maxResponseBytes: 1_000_000 }),
      ),
    ).resolves.toEqual({ status: "failed", reason: "response-too-large" });
    await expect(
      port().call(call("/test.daemon.v1.SpaceService/Answer", { maxResponseBytes: 4_096 })),
    ).resolves.toMatchObject({ status: "answered", grpcStatus: 0 });
  });

  it("stops reading a stream that claims a huge message as soon as it passes the bound", async () => {
    const streaming: Answer = (_request, response) => {
      response.writeHead(200, { "content-type": "application/grpc-web+proto" });
      const prefix = new Uint8Array(5);
      new DataView(prefix.buffer).setUint32(1, 1_073_741_824);
      response.write(prefix);
      for (let chunk = 0; chunk < 16; chunk += 1) response.write(new Uint8Array(65_536));
      response.end();
    };
    const { port } = await daemonHome({ "/test.daemon.v1.SpaceService/Answer": streaming });
    await expect(port().call(call("/test.daemon.v1.SpaceService/Answer"))).resolves.toEqual({
      status: "failed",
      reason: "response-too-large",
    });
  });

  it("reads a streamed answer whole only when the call says the method streams, bounding it all together", async () => {
    const twoMessages: Answer = (_request, response) => {
      response.writeHead(200, { "content-type": "application/grpc-web+proto" });
      response.end(
        joined(frame(0, message), frame(0, message.subarray(0, 2)), trailer("grpc-status: 0\r\n")),
      );
    };
    const { port } = await daemonHome({ "/test.daemon.v1.SpaceService/Answer": twoMessages });
    const streamed = call("/test.daemon.v1.SpaceService/Answer", { stream: true });
    await expect(port().call(streamed)).resolves.toEqual({
      status: "answered",
      grpcStatus: 0,
      grpcMessage: "",
      message,
      messages: [message, message.subarray(0, 2)],
    });
    await expect(
      port().call({ ...streamed, maxResponseBytes: message.byteLength + 1 }),
    ).resolves.toEqual({ status: "failed", reason: "response-too-large" });
    await expect(port().call(call("/test.daemon.v1.SpaceService/Answer"))).resolves.toEqual({
      status: "failed",
      reason: "response-invalid",
    });
    const notBoolean: DesktopDaemonRequest = Object.assign(call(CREATE), { stream: "yes" });
    await expect(port().call(notBoolean)).resolves.toEqual({
      status: "refused",
      reason: "request-invalid",
    });
  });

  it("answers a stream the daemon never ends as timed out", async () => {
    const { port } = await daemonHome({
      "/test.daemon.v1.SpaceService/Hang": (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.write(frame(0, message));
      },
    });
    await expect(
      port({ timeoutMs: 100 }).call(call("/test.daemon.v1.SpaceService/Hang", { stream: true })),
    ).resolves.toEqual({ status: "failed", reason: "timed-out" });
  });

  it("answers a daemon that never replies as timed out, and a cancelled call as cancelled", async () => {
    const { port } = await daemonHome({ "/test.daemon.v1.SpaceService/Hang": () => undefined });
    const hang = call("/test.daemon.v1.SpaceService/Hang");
    await expect(port({ timeoutMs: 50 }).call(hang)).resolves.toEqual({
      status: "failed",
      reason: "timed-out",
    });

    const controller = new AbortController();
    const pending = port().call({ ...hang, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toEqual({ status: "cancelled" });

    // Cancelled while the host is still checking the socket.
    const checking = new AbortController();
    const early = port().call({ ...hang, signal: checking.signal });
    checking.abort();
    await expect(early).resolves.toEqual({ status: "cancelled" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(port().call(call(CREATE, { signal: aborted.signal }))).resolves.toEqual({
      status: "cancelled",
    });
  });

  it.each<[string, Answer]>([
    [
      "an HTTP error",
      (_request, response) => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      },
    ],
    [
      "another content type",
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web-text" });
        response.end("AAAAAAA=");
      },
    ],
    [
      "two messages to a unary call",
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.end(joined(frame(0, message), frame(0, message), trailer("grpc-status: 0\r\n")));
      },
    ],
    [
      "no status",
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.end(frame(0, message));
      },
    ],
    [
      "a compressed message",
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.end(joined(frame(1, message), trailer("grpc-status: 0\r\n")));
      },
    ],
    [
      "a cut-off frame",
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.end(frame(0, message).subarray(0, 7));
      },
    ],
    [
      "bytes after the status",
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/grpc-web+proto" });
        response.end(joined(trailer("grpc-status: 0\r\n"), frame(0, message)));
      },
    ],
  ])("fails a daemon that answers with %s", async (_name, answer) => {
    const { port } = await daemonHome({ "/test.daemon.v1.SpaceService/Answer": answer });
    await expect(port().call(call("/test.daemon.v1.SpaceService/Answer"))).resolves.toEqual({
      status: "failed",
      reason: "response-invalid",
    });
  });
});
