import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createPinnedFetch, fetchPublicUrl, PublicFetchRefused } from "./nativeHarnessWebFetch";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers.host));
    response.setHeader("content-type", "text/plain");
    response.end("hello from the pinned address");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as { port: number }).port, seen };
}

describe("public web fetch", () => {
  it("opens the socket to the address that passed the check and still sends the hostname", async () => {
    const { port, seen } = await listen();
    // The name does not exist in DNS; only the pinned lookup can reach the server.
    const result = await fetchPublicUrl({
      url: `http://pinned.test:${port}/page`,
      maxBytes: 4_096,
      fetch: createPinnedFetch({ resolveAll: async () => ["127.0.0.1"], isPrivate: () => false }),
      resolveAddress: async () => "203.0.113.5",
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
