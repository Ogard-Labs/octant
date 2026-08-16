import { describe, expect, it, vi } from "vitest";
import type { LocalServerCommand } from "@octant/contracts";
import { createLocalServerClient, LocalServerClientFailure } from "./localServerClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const requestId = "00000000-0000-4000-8000-000000000904";
const threadId = "00000000-0000-4000-8000-000000000903";
const projectId = "00000000-0000-4000-8000-000000000902";

const listCommand = {
  kind: "list-local-servers",
  requestId,
  threadId,
  projectId,
} as unknown as LocalServerCommand;

const listedResult = {
  kind: "local-servers-listed",
  requestId,
  snapshot: {
    threadId,
    projectId,
    currentCheckout: [],
    other: [],
    observedAt: "2026-08-14T08:00:00.000Z",
  },
};

function client(fetchImpl: typeof globalThis.fetch) {
  return createLocalServerClient({
    baseUrl: "http://127.0.0.1:4319",
    fetch: fetchImpl,
    windowCapability: capability,
  });
}

describe("local server client", () => {
  it("posts the command with the window capability and decodes the result", async () => {
    const fetchImpl = vi.fn(async () => Response.json(listedResult));
    const result = await client(fetchImpl as unknown as typeof globalThis.fetch).execute(
      listCommand,
    );

    expect(result.kind).toBe("local-servers-listed");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4319/api/code/local-servers/commands");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(capability);
  });

  it("returns a typed rejection rather than throwing", async () => {
    const rejected = {
      kind: "local-server-rejected",
      requestId,
      failure: {
        category: "local-host-required",
        message: "Leftover Stop must happen on the host.",
      },
    };
    const result = await client(
      vi.fn(async () => Response.json(rejected)) as unknown as typeof globalThis.fetch,
    ).execute(listCommand);
    expect(result).toEqual(rejected);
  });

  it("surfaces the server message on an HTTP failure", async () => {
    const failing = vi.fn(async () =>
      Response.json({ message: "Local servers request is unauthorized." }, { status: 401 }),
    );
    await expect(
      client(failing as unknown as typeof globalThis.fetch).execute(listCommand),
    ).rejects.toMatchObject({ status: 401, message: "Local servers request is unauthorized." });
  });

  it("lists from a paired remote client over its authenticated HTTPS host", async () => {
    const fetchImpl = vi.fn(async () => Response.json(listedResult));
    const remote = createLocalServerClient({
      baseUrl: "https://mac.tail1234.ts.net",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      windowCapability: capability,
    });

    const result = await remote.execute(listCommand);

    expect(result.kind).toBe("local-servers-listed");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://mac.tail1234.ts.net/api/code/local-servers/commands");
  });

  it("still surfaces the host's leftover-stop denial to a remote client", async () => {
    const rejected = {
      kind: "local-server-rejected",
      requestId,
      failure: {
        category: "local-host-required",
        message: "Stopping a leftover server must happen on the host, not from a paired device.",
      },
    };
    const remote = createLocalServerClient({
      baseUrl: "https://mac.tail1234.ts.net",
      fetch: vi.fn(async () => Response.json(rejected)) as unknown as typeof globalThis.fetch,
      windowCapability: capability,
    });

    const result = await remote.execute({
      kind: "stop-local-server",
      requestId,
      threadId,
      projectId,
      listenerId: "lsn_0123456789abcdef0123456789abcdef",
    } as unknown as LocalServerCommand);

    expect(result).toEqual(rejected);
  });

  it("refuses a non-loopback base URL that is not authenticated transport", () => {
    expect(() =>
      createLocalServerClient({
        baseUrl: "http://mac.tail1234.ts.net",
        fetch: globalThis.fetch,
        windowCapability: capability,
      }),
    ).toThrow(LocalServerClientFailure);
  });
});
