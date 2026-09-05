import { describe, expect, it, vi } from "vitest";
import { createWorkFileListingClient, WorkFileListingClientFailure } from "./workFileListingClient";

function build(baseUrl: string) {
  return createWorkFileListingClient({
    baseUrl,
    fetch: vi.fn() as unknown as typeof globalThis.fetch,
    windowCapability: "capability",
  });
}

describe("createWorkFileListingClient", () => {
  it.each(["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"])(
    "accepts the loopback host %s",
    (baseUrl) => {
      // `URL.hostname` keeps the brackets on an IPv6 literal, so a host written
      // the way a browser writes it was refused as though it were remote.
      expect(() => build(baseUrl)).not.toThrow();
    },
  );

  it.each(["http://example.com", "http://192.168.1.10:5173", "http://octant.local"])(
    "refuses the non-loopback host %s",
    (baseUrl) => {
      expect(() => build(baseUrl)).toThrow(WorkFileListingClientFailure);
    },
  );

  it("refuses a base URL that is not a URL at all", () => {
    expect(() => build("not-a-url")).toThrow(WorkFileListingClientFailure);
  });
});
