// Synthetic Stable side of the Nightly client smoke.
//
// `smoke-nightly-client.ts` bundles this file and runs it in the Electron the
// desktop app ships. It stands where Octant's main stands for a Nightly
// window, without the signed native binding: it starts a development host on
// a throwaway data folder and port with a bridge secret only it holds, runs
// the real Browser surface host and runtime broker, an in-memory credential
// broker, and Stable's real lease owner and client lifetime. Nightly harness
// processes reach the lease owner over a private local socket that stands for
// the native window protocol; each connection is one native peer.
//
// It never opens a window of its own, never touches a person's data, Keychain
// or default folder, and stops its host and itself when its owner's standard
// input closes, on SIGTERM or SIGINT, or after its maximum lifetime.
//
// Never packaged: packaging refuses any payload that carries the marker below.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app, session } from "electron";
import { startCredentialBroker, type CredentialStore } from "@octant/host-runtime";
import { createBrowserSurfaceHost } from "../apps/desktop/src/browserSurfaceHost";
import { createBrowserProfileStore } from "../apps/desktop/src/browserProfileStore";
import { startBrowserRuntimeBroker } from "../apps/desktop/src/browserRuntimeBroker";
import { createOffscreenBrowserSurface } from "../apps/desktop/src/offscreenBrowserSurface";
import {
  ownNightlyWindowLeases,
  type NativeWindowBroker,
  type NativeWindowReply,
} from "../apps/desktop/src/nightlyBrowserLease";
import { createDesktopClientLifetime } from "../apps/desktop/src/desktopClientLifetime";

export const NIGHTLY_CLIENT_HARNESS_MARKER = "octant-nightly-client-harness@1";

const MAX_LIFETIME_MS = Number(process.env.OCTANT_HARNESS_MAX_LIFETIME_MS ?? 600_000);
const root = required("OCTANT_HARNESS_ROOT");
const work = required("OCTANT_HARNESS_WORK");
const port = Number(required("OCTANT_HARNESS_PORT"));
const socketPath = required("OCTANT_HARNESS_SOCKET");
const bun = required("OCTANT_HARNESS_BUN");
const dataDirectory = join(work, "data");
const hostHome = join(work, "home");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function emit(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`HARNESS ${JSON.stringify({ event, ...detail })}\n`);
}

function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    set: async (id, credential) => {
      values.set(id, credential);
    },
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new Error("No such credential.");
      return value;
    },
    delete: async (id) => {
      values.delete(id);
    },
    list: async () => [...values.keys()],
  };
}

app.setPath("userData", join(work, "stable-user-data"));
// A hidden lease owner: no Dock icon, and closing nothing quits nothing.
app.dock?.hide();
app.on("window-all-closed", () => {});

let host: ChildProcess | undefined;
let instanceId: string | undefined;
const bridgeSecret = randomBytes(32).toString("base64url");
let stopping: Promise<void> | undefined;

// Electron holds `ready` until a top-level await in an ESM main settles, so
// the harness starts from a function rather than awaiting at the top level.
async function main(): Promise<void> {
  await app.whenReady();
  for (const directory of [dataDirectory, hostHome, join(work, "logs"), join(work, "folder")])
    mkdirSync(directory, { recursive: true, mode: 0o700 });

  const credentialBroker = await startCredentialBroker(
    memoryStore(),
    undefined,
    undefined,
    memoryStore(),
    memoryStore(),
    memoryStore(),
    memoryStore(),
    memoryStore(),
    undefined,
    undefined,
    memoryStore(),
  );

  let leases: ReturnType<typeof ownNightlyWindowLeases> | undefined;
  const surfaceHost = createBrowserSurfaceHost({
    isOwnerWindowAvailable: (windowId) => leases?.hasWindow(windowId) === true,
    isEmbeddedOwner: (windowId) => leases?.hasWindow(windowId) === true,
    createView: (options) => createOffscreenBrowserSurface(options),
  });
  const profilesDirectory = join(work, "browser-profiles");
  const profileStore = createBrowserProfileStore({
    partitionsDirectory: profilesDirectory,
    sessionFor: (partition) => session.fromPartition(partition),
    closeProfilePages: (profile) => surfaceHost.closeProfileContexts(profile),
  });
  const browserBroker = await startBrowserRuntimeBroker(surfaceHost, profileStore);

  async function startHost(): Promise<void> {
    const nextInstance = randomUUID();
    const inherited = { ...process.env };
    for (const name of Object.keys(inherited))
      if (name.startsWith("OCTANT_") || name.startsWith("ELECTRON_")) delete inherited[name];
    const child = spawn(bun, [join(root, "apps/server/src/main.ts")], {
      cwd: join(root, "apps/server"),
      env: {
        ...inherited,
        HOME: hostHome,
        OCTANT_DATA_DIR: dataDirectory,
        OCTANT_LOGS_DIR: join(work, "logs"),
        OCTANT_DEFAULT_FOLDER: join(work, "folder"),
        OCTANT_SERVER_PORT: String(port),
        OCTANT_SERVER_INSTANCE_ID: nextInstance,
        OCTANT_HOST_SERVICE_MODE: "desktop",
        OCTANT_DESKTOP_PARENT_WATCH: "1",
        OCTANT_DESKTOP_BRIDGE_SECRET: bridgeSecret,
        OCTANT_BROWSER_BROKER_URL: browserBroker.url,
        OCTANT_BROWSER_BROKER_TOKEN: browserBroker.token,
        OCTANT_BROWSER_PROFILES_DIRECTORY: profilesDirectory,
        OCTANT_CREDENTIAL_BROKER_URL: credentialBroker.url,
        OCTANT_CREDENTIAL_BROKER_TOKEN: credentialBroker.token,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = `${errors}${chunk.toString("utf8")}`.slice(-4_000);
      // The smoke shows it only in verbose runs.
      process.stderr.write(chunk);
    });
    host = child;
    emit("host-process", { pid: child.pid });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`The development host exited during startup: ${errors}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        const health: unknown = await response.json();
        // As Octant's main does, a host is ready once its storage is.
        if (
          response.ok &&
          typeof health === "object" &&
          health !== null &&
          "storage" in health &&
          health.storage === "ready"
        ) {
          instanceId = nextInstance;
          emit("host-ready", { origin: `http://127.0.0.1:${port}`, instanceId, pid: child.pid });
          return;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`The development host did not become ready: ${errors}`);
  }

  async function stopHost(): Promise<void> {
    const child = host;
    host = undefined;
    instanceId = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    // Closing standard input is the host's desktop parent watch; SIGTERM backs it up.
    child.stdin?.end();
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(forced);
    emit("host-stopped", { pid: child.pid });
  }

  // The native window protocol, as one socket connection per Nightly peer.
  let listener: ((event: unknown) => void) | undefined;
  let nextRequest = 1;
  const pending = new Map<number, { readonly socket: Socket; readonly id: number }>();
  const peers = new Map<Socket, string>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    const peer = randomBytes(32).toString("hex");
    peers.set(socket, peer);
    sockets.add(socket);
    emit("peer-connected");
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      let message: { id?: unknown; operation?: unknown; handle?: unknown; generation?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const requestId = nextRequest++;
      pending.set(requestId, { socket, id: message.id });
      listener?.({
        kind: "request",
        request: {
          requestId,
          peer,
          windowId: message.handle,
          generation: message.generation,
          operation: message.operation,
          nativeMain: true,
        },
      });
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      sockets.delete(socket);
      const exited = peers.get(socket);
      peers.delete(socket);
      if (exited !== undefined) listener?.({ kind: "peer-exited", peer: exited });
    });
  });
  rmSync(socketPath, { force: true });
  await new Promise<void>((done) => server.listen(socketPath, done));

  const broker: NativeWindowBroker = {
    listenWindows: async (callback) => {
      listener = callback;
      return { kind: "listening" };
    },
    replyWindow: (requestId: number, reply: NativeWindowReply) => {
      const target = pending.get(requestId);
      pending.delete(requestId);
      if (target === undefined || target.socket.destroyed) return false;
      target.socket.write(`${JSON.stringify({ id: target.id, reply })}\n`);
      return true;
    },
    stopWindows: async () => {
      listener = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      return { kind: "closed" };
    },
  };

  let lastCount = 0;
  const lifetime = createDesktopClientLifetime({
    currentNightlyWindows: () => leases?.activeWindowCount() ?? 0,
    // The synthetic Stable has no local windows to close.
    closeLocalWindows: async () => "closed",
    quitHost: async (stillRequested) => {
      if (!stillRequested()) return "cancelled";
      emit("last-client-quit");
      await stopHost();
      return "accepted";
    },
  });
  leases = ownNightlyWindowLeases({
    native: broker,
    host: () =>
      instanceId === undefined
        ? undefined
        : {
            origin: `http://127.0.0.1:${port}`,
            instanceId,
            desktopBridgeSecret: bridgeSecret,
          },
    onActiveWindowCountChanged: (count) => {
      lastCount = count;
      emit("leases", { count });
      lifetime.nightlyWindowsChanged();
    },
    closeOwnerContexts: (windowId) => surfaceHost.closeOwnerContexts(windowId),
  });
  await leases.ready;

  async function shutdown(code: number): Promise<void> {
    stopping ??= (async () => {
      lifetime.dispose();
      await leases?.close().catch(() => undefined);
      await stopHost().catch(() => undefined);
      await surfaceHost.closeAll().catch(() => undefined);
      await browserBroker.close().catch(() => undefined);
      await credentialBroker.close().catch(() => undefined);
      rmSync(socketPath, { force: true });
      emit("stopped");
    })();
    await stopping;
    app.exit(code);
  }

  const lifetimeTimer = setTimeout(() => void shutdown(3), MAX_LIFETIME_MS);
  lifetimeTimer.unref();
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));

  const commands = createInterface({ input: process.stdin });
  commands.on("close", () => void shutdown(0));
  commands.on("line", (line) => {
    void (async () => {
      const command = line.trim();
      try {
        if (command === "status")
          emit("status", { leases: leases?.activeWindowCount() ?? 0, lastCount, instanceId });
        else if (command === "drop-peers") {
          // What Stable's native binding reports when a peer's audit incarnation exits.
          for (const peer of peers.values()) listener?.({ kind: "peer-exited", peer });
          emit("peers-dropped");
        } else if (command === "restart-host") {
          const finish = lifetime.beginHostRestart();
          await stopHost();
          await startHost();
          finish(true);
          emit("host-restarted", { instanceId });
        } else if (command === "ui-quit") {
          emit("ui-quit", { result: await lifetime.requestLocalQuit() });
        } else if (command === "shutdown") await shutdown(0);
      } catch (error) {
        emit("command-failed", { command, message: String(error) });
      }
    })();
  });

  await startHost();
  emit("ready", { marker: NIGHTLY_CLIENT_HARNESS_MARKER });
}

void main().catch((error: unknown) => {
  emit("command-failed", { command: "start", message: String(error) });
  app.exit(1);
});
