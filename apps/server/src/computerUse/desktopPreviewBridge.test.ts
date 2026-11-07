import { request } from "node:http";
import { mkdtemp, rm, lstat, unlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopPreviewBridge } from "./desktopPreviewBridge";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function ask(socketPath: string, nonce: string, path = "/page") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      { socketPath, path, headers: { "x-octant-preview-key": nonce } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("a desktop lease's private preview bridge", () => {
  it("relays only authenticated HTTP requests and removes its proof before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "op-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, "p.sock");
    const relay = vi.fn(async (input) => {
      expect(
        input.headers.some(([name]: readonly [string, string]) => name === "x-octant-preview-key"),
      ).toBe(false);
      return new Response("selected app", { status: 200 });
    });
    const controller = new AbortController();
    const bridge = await createDesktopPreviewBridge({
      socketPath: socketPath + ".host",
      exposedPath: socketPath,
      nonce: "a".repeat(43),
      relay: { request: relay, upgrade: async () => ({ status: "refused" }) },
      signal: controller.signal,
    });
    cleanups.push(bridge.close);
    await expect(ask(socketPath, "b".repeat(43))).resolves.toEqual({
      status: 401,
      body: "Preview unavailable.",
    });
    expect(relay).not.toHaveBeenCalled();
    await expect(ask(socketPath, "a".repeat(43))).resolves.toEqual({
      status: 200,
      body: "selected app",
    });
    expect(relay).toHaveBeenCalledOnce();
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
    controller.abort();
    await bridge.close();
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses absolute and authority-shaped request targets before reaching the approved app", async () => {
    const directory = await mkdtemp(join(tmpdir(), "op-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const relay = vi.fn(async () => new Response("wrong"));
    const socketPath = join(directory, "p.sock");
    const bridge = await createDesktopPreviewBridge({
      socketPath: socketPath + ".host",
      exposedPath: socketPath,
      nonce: "a".repeat(43),
      relay: { request: relay, upgrade: async () => ({ status: "refused" }) },
      signal: new AbortController().signal,
    });
    cleanups.push(bridge.close);
    for (const path of ["http://127.0.0.1:1/", "//127.0.0.1:1/"]) {
      expect((await ask(socketPath, "a".repeat(43), path)).status).toBe(400);
    }
    expect(relay).not.toHaveBeenCalled();
  });

  it("leaves a foreign replacement at its old socket path untouched during cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "op-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, "p.sock");
    const bridge = await createDesktopPreviewBridge({
      socketPath: socketPath + ".host",
      exposedPath: socketPath,
      nonce: "a".repeat(43),
      relay: {
        request: async () => new Response("app"),
        upgrade: async () => ({ status: "refused" }),
      },
      signal: new AbortController().signal,
    });
    cleanups.push(bridge.close);
    await unlink(socketPath);
    await writeFile(socketPath, "replacement");
    await bridge.close();
    expect(await readFile(socketPath, "utf8")).toBe("replacement");
  });
});
