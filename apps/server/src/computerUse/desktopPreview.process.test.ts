import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as reservePort } from "node:net";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeDesktopHostTag, decodeDesktopLeaseId } from "@octant/contracts";
import { relayRequestHeaders, relayWebSocketRequestHeaders } from "@octant/domain";
import { createDesktopPreviewBridge } from "./desktopPreviewBridge";
import { HOST_LOCAL_PREVIEW_PROXY } from "../plugins/hostLocalDesktop/hostLocalPreviewProxy";
import {
  DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
  relayToDevServer,
  openDevServerWebSocket,
} from "../remote/remoteServerProxyRelay";
import {
  WebSocketEndpoint,
  isWebSocketKey,
  newWebSocketKey,
  webSocketAcceptFor,
} from "../webSocketRelay";
import { createHostLocalDesktopLaunch } from "./hostLocalDesktopLaunch";
import type { DesktopPreviewRelay } from "@octant/plugin-api/desktop-provider";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function app() {
  let requests = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    requests++;
    expect(request.headers["x-octant-preview-key"]).toBeUndefined();
    response.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": [
        "preview_session=synthetic; Path=/; HttpOnly; SameSite=Lax",
        "preview_csrf=synthetic; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; SameSite=Lax",
        "octant-fixture=blocked; Path=/",
      ],
      "x-octant-fixture": "blocked",
    });
    response.write("selected ");
    setTimeout(() => response.end("app"), 5);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const key = request.headers["sec-websocket-key"];
    if (!isWebSocketKey(key)) {
      socket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${webSocketAcceptFor(key)}\r\n\r\n`,
    );
    const peer = new WebSocketEndpoint(socket as import("node:net").Socket, "server", 1024 * 1024);
    peer.start({ message: (message) => peer.send(message), closed: () => undefined }, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("app not listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: address.port, requests: () => requests };
}

function relay(port: number): DesktopPreviewRelay {
  const origin = `http://127.0.0.1:${port}`;
  const headers = (input: ReadonlyArray<readonly [string, string]>) => ({
    headers: input,
    listenerOrigin: origin,
    grantPath: "",
    upstream: { scheme: "http" as const, port },
  });
  return {
    request: async (input) => {
      const result = await relayToDevServer({
        endpointUrl: `${origin}/`,
        request: {
          method: input.method,
          pathQuery: input.pathQuery,
          headers: relayRequestHeaders({
            ...headers(input.headers),
            bodyBytes: input.body?.length,
          }),
          body: input.body,
        },
        acceptCertificate: () => false,
        signal: input.signal,
        onSettled: () => undefined,
        limits: DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
      });
      return result.kind === "responded"
        ? result.response
        : new Response("unavailable", { status: 502 });
    },
    upgrade: async (input) => {
      const key = newWebSocketKey();
      const result = await openDevServerWebSocket({
        endpointUrl: `${origin}/`,
        pathQuery: input.pathQuery,
        key,
        protocols: [],
        headers: relayWebSocketRequestHeaders({ ...headers(input.headers), key }),
        acceptCertificate: () => false,
        signal: input.signal,
        limits: DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
      });
      if (result.kind !== "opened") return { status: "refused" };
      const upstream = new WebSocketEndpoint(result.socket, "client", 1024 * 1024);
      const end = () => result.socket.destroy();
      input.signal.addEventListener("abort", end, { once: true });
      result.socket.once("close", () => input.signal.removeEventListener("abort", end));
      return {
        status: "opened",
        cancel: end,
        open: (guest) => {
          upstream.start(
            {
              message: (message) => guest.send(message),
              closed: (code, reason) => guest.close(code, reason),
            },
            result.head,
          );
          return { message: upstream.send.bind(upstream), closed: upstream.close.bind(upstream) };
        },
      };
    },
  };
}

async function unusedPort() {
  const server = reservePort();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port missing");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function outputWait(read: () => string, predicate: (value: string) => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (predicate(read())) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("owned preview did not answer"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("the actual lease preview proxy", () => {
  it("streams HTTP and a bidirectional WebSocket through the private authenticated bridge, then cuts both on revoke", async () => {
    const selected = await app();
    const directory = await mkdtemp(join(tmpdir(), "op-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const nonce = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    const bridge = await createDesktopPreviewBridge({
      socketPath: join(directory, "host.sock"),
      exposedPath: join(directory, "p.sock"),
      nonce,
      relay: relay(selected.port),
      signal: controller.signal,
    });
    cleanups.push(bridge.close);
    const port = await unusedPort();
    const child = spawn(process.execPath, ["--input-type=module", "-e", HOST_LOCAL_PREVIEW_PROXY], {
      env: { HOME: directory },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    cleanups.push(async () => {
      child.kill("SIGTERM");
      await exited;
    });
    child.stdin?.end(
      JSON.stringify({
        socketName: "p.sock",
        nonce,
        port,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }) + "\n",
    );
    await outputWait(
      () => output,
      (text) => text.includes(`ready ${port}`),
    );
    const received = await fetch(`http://127.0.0.1:${port}/`);
    expect(await received.text()).toBe("selected app");
    expect(received.headers.getSetCookie()).toEqual([
      "preview_session=synthetic; Path=/; HttpOnly; SameSite=Lax",
      "preview_csrf=synthetic; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; SameSite=Lax",
    ]);
    expect(received.headers.get("x-octant-fixture")).toBeNull();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    const echoed = new Promise<string>((resolve) => {
      socket.onmessage = (event) => resolve(String(event.data));
    });
    socket.send("reload");
    expect(await echoed).toBe("reload");
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    controller.abort();
    await bridge.close();
    await closed;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect(selected.requests()).toBe(1);
  });
});

const native =
  process.platform === "linux" &&
  existsSync("/usr/bin/bwrap") &&
  (existsSync("/usr/bin/node") || existsSync("/usr/local/bin/node"));
describe("the native lease preview boundary", () => {
  it("requires its isolation prerequisites in the hosted proof job", () => {
    if (process.env.OCTANT_REQUIRE_DESKTOP_PREVIEW_ISOLATION === "1") expect(native).toBe(true);
  });
  it.runIf(native)(
    "uses the production capsule and held directory to expose only the selected app, without host data or inherited host descriptors",
    async () => {
      const selected = await app();
      const foreign = await app();
      const root = await mkdtemp(join(tmpdir(), "op-native-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const secret = join(root, "host-only");
      await writeFile(secret, "fixture secret");
      const leaseId = decodeDesktopLeaseId(randomUUID());
      const hostTag = decodeDesktopHostTag(randomUUID());
      const launch = createHostLocalDesktopLaunch({
        directory: join(root, "leases"),
        hostTag,
        platform: "linux",
        provisioning: () => true,
        stopTimeoutMs: 2000,
      });
      cleanups.push(async () => {
        await launch.stop(leaseId);
      });
      let output = "";
      const probe = `import * as probeFs from 'node:fs';
const probeWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const result = probeWrite(chunk, ...args);
  if (String(chunk).startsWith('ready ')) setTimeout(async () => {
    const facts = {};
    facts.http = await (await fetch('http://127.0.0.1:${selected.port}/')).text();
    facts.hostPortDenied = await fetch('http://127.0.0.1:${foreign.port}/').then(() => false, () => true);
    facts.hostFileDenied = (() => { try { probeFs.readFileSync(${JSON.stringify(secret)}); return false; } catch { return true; } })();
    facts.noHostDirectoryFd = probeFs.readdirSync('/proc/self/fd').every(name => { try { return !probeFs.readlinkSync('/proc/self/fd/' + name).includes('/leases/desktops/'); } catch { return true; } });
    facts.ws = await new Promise(async (resolve) => {
      const http = await import('node:http');
      const request = http.request({host:'127.0.0.1',port:${selected.port},path:'/hmr',headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'YWJjZGVmZ2hpamtsbW5vcA=='}});
      request.on('upgrade', (_response, socket, head) => {
        const mask = Buffer.from([1,2,3,4]); const payload = Buffer.from('reload');
        const frame = Buffer.concat([Buffer.from([0x81,0x86]),mask,Buffer.from(payload.map((byte,index)=>byte^mask[index%4]))]);
        let received = head;
        const read = (bytes) => { received=Buffer.concat([received,bytes]); if(received.length>=8){ resolve(received.subarray(2,8).toString());socket.destroy(); } };
        socket.on('data',read);socket.on('error',()=>resolve('failed'));socket.write(frame);read(Buffer.alloc(0));
      });
      request.on('error',()=>resolve('failed'));request.end();
    });
    const alias = probeFs.readdirSync(process.env.HOME).find(name => /^preview-.*\\.sock$/.test(name));
    if (alias) { probeFs.unlinkSync(alias); probeFs.writeFileSync(alias, 'guest replacement'); }
    probeWrite('probe ' + JSON.stringify(facts) + '\\n');
  }, 10);
  return result;
};\n`;
      const started = await launch.launch({
        leaseId,
        hostTag,
        program: "node",
        args: ["--input-type=module", "-e", probe + HOST_LOCAL_PREVIEW_PROXY],
        output: (chunk) => {
          output += new TextDecoder().decode(chunk);
        },
        signal: new AbortController().signal,
      });
      expect(started.status).toBe("launched");
      if (started.status !== "launched" || launch.preparePreview === undefined)
        throw new Error("native launch refused");
      const controller = new AbortController();
      const prepared = await launch.preparePreview(leaseId, {
        grantId: randomUUID(),
        port: selected.port,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        relay: relay(selected.port),
        signal: controller.signal,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") throw new Error("native bridge refused");
      cleanups.push(prepared.close);
      // Start a different actual capsule while both host directory descriptors
      // are held. Inherited host descriptors must never bypass its mounts.
      const otherId = decodeDesktopLeaseId(randomUUID());
      const firstHome = join(root, "leases", "desktops", String(leaseId), "home");
      const otherHome = join(root, "leases", "desktops", String(otherId), "home");
      let otherOutput = "";
      const other = await launch.launch({
        leaseId: otherId,
        hostTag,
        program: "node",
        args: [
          "--input-type=module",
          "-e",
          `
          import * as fs from 'node:fs';
          const noHostFd = fs.readdirSync('/proc/self/fd').every(name => {
            try { return !fs.readlinkSync('/proc/self/fd/' + name).includes('/leases/desktops/'); }
            catch { return true; }
          });
          const foreignLeaseDenied = !fs.existsSync(${JSON.stringify(firstHome)});
          console.log('foreign ' + JSON.stringify({ noHostFd, foreignLeaseDenied }));
          setTimeout(() => {}, 60000);
        `,
        ],
        output: (bytes) => {
          otherOutput += new TextDecoder().decode(bytes);
        },
        signal: new AbortController().signal,
      });
      expect(other.status).toBe("launched");
      cleanups.push(async () => {
        await launch.stop(otherId);
      });
      await outputWait(
        () => otherOutput,
        (text) => text.includes("foreign "),
      );
      const otherLine = otherOutput.split("\n").find((text) => text.startsWith("foreign "));
      expect(JSON.parse(otherLine?.slice(8) ?? "null")).toEqual({
        noHostFd: true,
        foreignLeaseDenied: true,
      });
      const previewInput = {
        grantId: randomUUID(),
        port: selected.port,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        relay: relay(selected.port),
        signal: new AbortController().signal,
      };
      // Neither a path symlink nor a guest-loosened home is eligible. Both
      // negatives exercise the production O_NOFOLLOW/held-identity checks.
      const movedHome = otherHome + "-held";
      await rename(otherHome, movedHome);
      await symlink(firstHome, otherHome);
      expect(await launch.preparePreview(otherId, previewInput)).toEqual({ status: "unavailable" });
      await unlink(otherHome);
      await rename(movedHome, otherHome);
      await chmod(otherHome, 0o755);
      expect(await launch.preparePreview(otherId, previewInput)).toEqual({ status: "unavailable" });
      await chmod(otherHome, 0o700);
      await started.desktop.write(
        new TextEncoder().encode(
          JSON.stringify({
            socketName: prepared.socketName,
            nonce: prepared.nonce,
            port: selected.port,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }) + "\n",
        ),
      );
      await outputWait(
        () => output,
        (text) => text.includes("probe "),
      );
      const line = output.split("\n").find((text) => text.startsWith("probe "));
      expect(JSON.parse(line?.slice(6) ?? "null")).toEqual({
        http: "selected app",
        hostPortDenied: true,
        hostFileDenied: true,
        noHostDirectoryFd: true,
        ws: "reload",
      });
      expect(foreign.requests()).toBe(0);
      controller.abort();
      await prepared.close();
      expect(await readFile(join(firstHome, prepared.socketName), "utf8")).toBe(
        "guest replacement",
      );
      expect(await launch.stop(leaseId)).toEqual({ status: "released" });
      expect(await launch.inspect(leaseId)).toEqual({ status: "gone" });
    },
  );
});
