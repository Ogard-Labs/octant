import { describe, expect, it } from "vitest";
import { decodeCodeFileListing, decodeCodeFileListingEntry } from "./codeFileListing";

const ids = {
  thread: "11111111-1111-4111-8111-111111111111",
  checkout: "22222222-2222-4222-8222-222222222222",
  file: "33333333-3333-4333-8333-333333333333",
} as const;

const fileEntry = {
  kind: "file",
  fileId: ids.file,
  path: "apps/web/src/main.tsx",
  byteLength: 2_048,
  availability: { status: "available" },
} as const;

describe("code file listing contracts", () => {
  it("decodes directory and file entries with server-decided availability", () => {
    expect(decodeCodeFileListingEntry({ kind: "directory", path: "apps/web" }).kind).toBe(
      "directory",
    );
    expect(decodeCodeFileListingEntry(fileEntry).kind).toBe("file");
    expect(
      decodeCodeFileListingEntry({
        ...fileEntry,
        availability: { status: "read-only", reason: "oversized" },
      }).kind,
    ).toBe("file");
  });

  it("rejects an entry carrying a host absolute path", () => {
    expect(() =>
      decodeCodeFileListingEntry({ ...fileEntry, path: "/Users/example/code/octant/main.tsx" }),
    ).toThrow();
    expect(() =>
      decodeCodeFileListingEntry({ ...fileEntry, path: "../outside/main.tsx" }),
    ).toThrow();
    expect(() =>
      decodeCodeFileListingEntry({ ...fileEntry, absolutePath: "/Users/example/code" }),
    ).toThrow();
  });

  it("keeps truncation authoritative on the listing", () => {
    const listing = decodeCodeFileListing({
      kind: "code-file-listing",
      threadId: ids.thread,
      checkoutId: ids.checkout,
      entries: [fileEntry],
      truncated: true,
      observedAt: "2026-08-14T08:00:00.000Z",
    });
    expect(listing.truncated).toBe(true);
    expect(listing.directory).toBeUndefined();
  });
});
