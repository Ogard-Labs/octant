import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  writeBridgeSecretFile,
  writeHostInfoFile,
  type BridgeSecretFileInput,
} from "./bridgeSecretFile";
import { openLocalControlSession } from "./localControl";

const secret = `${"S".repeat(42)}A`;
const filesystemTestPlatform: NodeJS.Platform = process.platform === "darwin" ? "darwin" : "linux";

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

async function withRunningHost<T>(fn: (host: BridgeSecretFileInput) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "octant-local-control-"));
  try {
    const host: BridgeSecretFileInput = {
      env: { OCTANT_DATA_DIR: directory },
      platform: filesystemTestPlatform,
      home: directory,
    };
    await writeBridgeSecretFile(host, secret);
    await writeHostInfoFile(host, {
      url: "http://127.0.0.1:13773",
      instanceId: "11111111-1111-4111-8111-111111111111",
    });
    return await fn(host);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("openLocalControlSession", () => {
  it("refuses the command when this host is not running Octant", async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), "octant-local-control-"));
    try {
      const session = await openLocalControlSession({
        host: {
          env: { OCTANT_DATA_DIR: directory },
          platform: filesystemTestPlatform,
          home: directory,
        },
        fetch: mockFetch(() => Promise.reject(new Error("connection refused"))),
      });
      expect(session.kind).toBe("refuses");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses the command when the running server never grants it authority", async () => {
    await withRunningHost(async (host) => {
      const session = await openLocalControlSession({
        host,
        fetch: mockFetch(() => Promise.reject(new Error("connection reset"))),
      });
      expect(session).toEqual({
        kind: "refuses",
        reason: "Octant refused this command's local authority.",
      });
    });
  });

  it("reports a server that stops answering mid-command instead of failing the process", async () => {
    await withRunningHost(async (host) => {
      let registered = false;
      const session = await openLocalControlSession({
        host,
        fetch: mockFetch((input) => {
          if (!registered && String(input).endsWith("/api/desktop/window-authorities")) {
            registered = true;
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.reject(new Error("connection reset"));
        }),
      });
      if (session.kind !== "opened") throw new Error("Expected an opened session.");

      const response = await session.send({ path: "/api/chat/projects", method: "GET" });

      expect(response.status).toBe(0);
      expect(response.body).toEqual({
        message: "Octant stopped answering on this host before the command finished.",
      });
      await expect(session.close()).resolves.toBeUndefined();
    });
  });
});
