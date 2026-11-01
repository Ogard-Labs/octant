import { describe, expect, it } from "vitest";
import { BrowserDownloadReport, BrowserObservation } from "./browserAutomation";
import {
  BROWSER_DOWNLOAD_EVENT_NAMES,
  decodeBrowserDownloadRefused,
  decodeBrowserDownloadSaved,
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
} from "./browserDownload";
import { Schema } from "effect";

const threadId = "d0000000-0000-4000-8000-00000000000a";
const at = "2026-11-01T09:00:00.000Z";

describe("Browser download contracts", () => {
  it("names the two journal events and keeps the cap the upload cap", () => {
    expect(BROWSER_DOWNLOAD_EVENT_NAMES).toEqual({
      saved: "browser.download-saved@1",
      refused: "browser.download-refused@1",
    });
    expect(MAX_BROWSER_DOWNLOAD_FILE_BYTES).toBe(25 * 1024 * 1024);
  });

  it("records a saved download by digest and refuses bytes or unknown fields", () => {
    const saved = {
      threadId,
      origin: "https://example.com",
      path: "downloads/report.pdf",
      sizeBytes: 12,
      mediaType: "application/pdf",
      sha256: "a".repeat(64),
      savedAt: at,
    };
    expect(decodeBrowserDownloadSaved(saved)).toEqual(saved);
    expect(() => decodeBrowserDownloadSaved({ ...saved, bytes: "AAAA" })).toThrow();
    expect(() => decodeBrowserDownloadSaved({ ...saved, sha256: "short" })).toThrow();
    expect(() =>
      decodeBrowserDownloadSaved({ ...saved, sizeBytes: MAX_BROWSER_DOWNLOAD_FILE_BYTES + 1 }),
    ).toThrow();
  });

  it("records a refused download with a bounded reason", () => {
    const refused = {
      threadId,
      origin: "https://example.com",
      name: "tool.txt",
      reason: "executable",
      refusedAt: at,
    };
    expect(decodeBrowserDownloadRefused(refused)).toEqual(refused);
    expect(() => decodeBrowserDownloadRefused({ ...refused, reason: "because" })).toThrow();
  });

  it("reports a held or a stopped download in an observation", () => {
    const decode = Schema.decodeUnknownSync(BrowserDownloadReport);
    expect(
      decode({
        state: "held",
        downloadId: "d1",
        name: "a.pdf",
        sizeBytes: 3,
        mediaType: "application/pdf",
      }),
    ).toBeDefined();
    expect(decode({ state: "refused", name: "big.bin", reason: "too-large" })).toBeDefined();
    expect(() =>
      decode({ state: "held", downloadId: "../x", name: "a", sizeBytes: 1, mediaType: "a/b" }),
    ).toThrow();
    expect(BrowserObservation.fields.downloads).toBeDefined();
  });
});
