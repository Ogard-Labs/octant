import { describe, expect, it, vi } from "vitest";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts";
import { createCodeFileListingClient, CodeFileListingClientFailure } from "./codeFileListingClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const threadId = "00000000-0000-4000-8000-000000000903" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000902" as CodeCheckoutId;

const listedResult = {
  status: "listed",
  listing: {
    kind: "code-file-listing",
    threadId,
    checkoutId,
    entries: [{ kind: "directory", path: "apps" }],
    truncated: false,
    observedAt: "2026-08-14T08:00:00.000Z",
  },
};

function client(fetchImpl: typeof globalThis.fetch) {
  return createCodeFileListingClient({
    baseUrl: "http://127.0.0.1:4319",
    fetch: fetchImpl,
    windowCapability: capability,
  });
}

describe("code file listing client", () => {
  it("requests the listing for a thread checkout and decodes it", async () => {
    const fetchImpl = vi.fn(async () => Response.json(listedResult));
    const result = await client(fetchImpl as unknown as typeof globalThis.fetch).list({
      threadId,
      checkoutId,
    });

    expect(result.status).toBe("listed");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("/api/code/files/listing?");
    expect(url).toContain(`threadId=${String(threadId)}`);
    expect(url).toContain(`checkoutId=${String(checkoutId)}`);
  });

  it("passes a subdirectory through when one is requested", async () => {
    const fetchImpl = vi.fn(async () => Response.json(listedResult));
    await client(fetchImpl as unknown as typeof globalThis.fetch).list({
      threadId,
      checkoutId,
      directory: "apps/web" as CodeRelativePath,
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("directory=apps%2Fweb");
  });

  it("returns a typed failure result rather than throwing", async () => {
    const failed = {
      status: "failed",
      failure: { category: "unavailable", message: "Code file listing is unavailable." },
    };
    const result = await client(
      vi.fn(async () => Response.json(failed)) as unknown as typeof globalThis.fetch,
    ).list({ threadId, checkoutId });
    expect(result).toEqual(failed);
  });

  it("surfaces the server message on an HTTP failure", async () => {
    const failing = vi.fn(async () =>
      Response.json({ message: "Code request is unauthorized." }, { status: 401 }),
    );
    await expect(
      client(failing as unknown as typeof globalThis.fetch).list({ threadId, checkoutId }),
    ).rejects.toMatchObject({ status: 401, message: "Code request is unauthorized." });
  });

  it("refuses a base URL that is not loopback", () => {
    expect(() =>
      createCodeFileListingClient({
        baseUrl: "https://example.com",
        fetch: globalThis.fetch,
        windowCapability: capability,
      }),
    ).toThrow(CodeFileListingClientFailure);
  });
});
