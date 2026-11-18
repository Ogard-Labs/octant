import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinnedFetch, fetchPublicUrl, PublicFetchRefused } from "./nativeHarnessWebFetch";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { sandboxLocalServiceAllowed } from "@octant/domain/sandbox-policy";
import {
  configureSandboxRestrictionsAuthority,
  configureSandboxToolNetwork,
  withSandboxToolPolicy,
} from "../process/sandboxRuntimePolicy";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(() => {
  configureSandboxRestrictionsAuthority(undefined);
  configureSandboxToolNetwork(undefined, () => true);
  for (const server of servers.splice(0)) server.close();
});

async function listen(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers.host));
    response.setHeader("content-type", "text/plain");
    if (request.url === "/hold") {
      response.write("held response");
      return;
    }
    response.end("hello from the pinned address");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as { port: number }).port, seen };
}

describe("public web fetch", () => {
  it("reaches a granted local service only inside the admitted tool scope and rechecks redirects", async () => {
    const origin = await listen();
    const neighbor = await listen();
    const selected = decodeSandboxPolicySelection({
      policy: {
        schemaVersion: 1,
        revision: 1,
        filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
        network: "deny",
        credentials: "existing-policy",
        hostServices: "blocked",
        localServices: [{ host: "127.0.0.1", port: origin.port }],
      },
      context: {
        root: "/project",
        hostId: "host",
        projectId: "20000000-0000-4000-8000-000000000001",
        checkoutId: "checkout",
        sessionId: "local-fetch",
        provider: "codex",
      },
    });
    const cleanups = new Set<() => Promise<void>>();
    configureSandboxRestrictionsAuthority({
      validateSelection: () => true,
      active: () => selected,
      beginTurn: () => ({ status: "refused", message: "unused" }),
      storageDirectory: () => undefined,
      deny: () => undefined,
      registerCleanup: (_session, cleanup) => {
        cleanups.add(cleanup);
        return () => {
          cleanups.delete(cleanup);
        };
      },
    });
    configureSandboxToolNetwork(
      async () => ({
        permitsHostRequest: (host, port) =>
          sandboxLocalServiceAllowed(selected.policy.localServices, host, port),
        environment: {},
        networkEgress: "none",
        close: async () => undefined,
      }),
      () => true,
    );
    const url = `http://127.0.0.1:${origin.port}/page`;
    await withSandboxToolPolicy("thread", async () => {
      expect((await fetchPublicUrl({ url, maxBytes: 1024 })).text).toBe(
        "hello from the pinned address",
      );
      await expect(
        fetchPublicUrl({ url: `http://127.0.0.1:${neighbor.port}`, maxBytes: 1024 }),
      ).rejects.toThrow(/refused/);
      await expect(
        fetchPublicUrl({
          url,
          maxBytes: 1024,
          fetch: async () =>
            new Response(null, {
              status: 302,
              headers: { location: `http://127.0.0.1:${neighbor.port}/redirected` },
            }),
        }),
      ).rejects.toThrow(/refused/);
    });
    await expect(fetchPublicUrl({ url, maxBytes: 1024 })).rejects.toMatchObject({
      reason: "private-destination",
    });
    expect(origin.seen).toEqual([`127.0.0.1:${origin.port}`]);
    expect(neighbor.seen).toEqual([]);
    const pending = withSandboxToolPolicy("thread", () =>
      fetchPublicUrl({
        url: `http://127.0.0.1:${origin.port}/hold`,
        maxBytes: 1024,
      }),
    );
    const cancelled = expect(pending).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(origin.seen).toHaveLength(2));
    await Promise.all([...cleanups].map((cleanup) => cleanup()));
    await cancelled;
    expect(cleanups.size).toBe(0);
  });
  it("opens the socket to the address that passed the check and still sends the hostname", async () => {
    const { port, seen } = await listen();
    // The name does not exist in DNS; only the pinned lookup can reach the server.
    const result = await fetchPublicUrl({
      url: `http://pinned.test:${port}/page`,
      maxBytes: 4_096,
      fetch: createPinnedFetch({ resolveAll: async () => ["127.0.0.1"], isPrivate: () => false }),
      resolveAddress: async () => "93.184.216.5",
    });
    expect(result.status).toBe(200);
    expect(result.text).toBe("hello from the pinned address");
    expect(seen).toEqual([`pinned.test:${port}`]);
  });

  it("refuses at connect time when any address the name resolves to is private", async () => {
    const { port } = await listen();
    await expect(
      fetchPublicUrl({
        url: `http://rebinding.test:${port}/page`,
        maxBytes: 4_096,
        fetch: createPinnedFetch({ resolveAll: async () => ["93.184.216.34", "127.0.0.1"] }),
        resolveAddress: async () => "93.184.216.34",
      }),
    ).rejects.toMatchObject({ name: "PublicFetchRefused", reason: "private-destination" });
    expect(new PublicFetchRefused("x").reason).toBe("x");
  });
});
