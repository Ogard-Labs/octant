import { request } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { canvasExportWorkerFetch } from "./canvasExportWorkerFetch";

vi.mock("node:https", () => ({
  request: vi.fn(() => {
    throw new Error("Unexpected network dispatch.");
  }),
}));
const input = {
  kind: "fetch",
  id: 1,
  url: "https://example.test/pages",
  method: "POST",
  headers: { "content-type": "application/json" },
  bodyBase64: "aGVsbG8=",
} as const;
describe("Canvas export egress admission", () => {
  it.each([
    { ...input, url: "http://example.test/pages" },
    { ...input, url: "https://other.test/pages" },
    { ...input, url: "https://person:password@example.test/pages" },
    { ...input, headers: { authorization: "package-supplied" } },
    { ...input, headers: { cookie: "account=value" } },
  ])(
    "refuses out-of-scope destinations and credential headers before dispatch: %j",
    async (value) => {
      vi.mocked(request).mockClear();
      await expect(
        canvasExportWorkerFetch(
          value,
          ["https://example.test"],
          () => true,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("refuses revoked authority or cancellation before dispatch", async () => {
    vi.mocked(request).mockClear();
    await expect(
      canvasExportWorkerFetch(
        input,
        ["https://example.test"],
        () => false,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      canvasExportWorkerFetch(input, ["https://example.test"], () => true, aborted.signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

it.each([
  "https://127.0.0.1/",
  "https://10.0.0.1/",
  "https://[::1]/",
  "https://[::ffff:127.0.0.1]/",
  "https://2130706433/",
])("refuses a private IP literal even when that exact origin was declared: %s", async (url) => {
  vi.mocked(request).mockClear();
  await expect(
    canvasExportWorkerFetch(
      { ...input, url },
      [new URL(url).origin],
      () => true,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
