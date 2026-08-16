import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePreviewSourceVersion, samePreviewSourceVersion } from "./previewSourceVersion";

const root = mkdtempSync(join(tmpdir(), "preview-version-"));
const filePath = join(root, "doc.txt");

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(filePath, "hello world");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computePreviewSourceVersion", () => {
  it("produces a content-sha256 version for an existing file", () => {
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (version.ok) {
      const expected = createHash("sha256").update("hello world").digest("hex");
      expect(version.sourceVersion.contentSha256).toBe(expected);
      expect(version.sourceVersion.byteSize).toBe(11);
      expect(version.sourceVersion.observedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  it("fails with unavailable when the file does not exist", () => {
    const result = computePreviewSourceVersion(join(root, "missing.txt"));
    expect(result).toEqual({ ok: false, code: "unavailable" });
  });

  it("produces a different content hash when the file content changes", () => {
    const first = computePreviewSourceVersion(filePath);
    expect(first.ok).toBe(true);
    writeFileSync(filePath, "hello world 2");
    const second = computePreviewSourceVersion(filePath);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.sourceVersion.contentSha256).not.toBe(second.sourceVersion.contentSha256);
    }
  });
});

describe("samePreviewSourceVersion", () => {
  it("matches identical versions", () => {
    const v = computePreviewSourceVersion(filePath);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(samePreviewSourceVersion(v.sourceVersion, v.sourceVersion)).toBe(true);
    }
  });

  it("rejects differing content hashes", () => {
    const a = computePreviewSourceVersion(filePath);
    writeFileSync(filePath, "different content");
    const b = computePreviewSourceVersion(filePath);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(samePreviewSourceVersion(a.sourceVersion, b.sourceVersion)).toBe(false);
    }
  });
});
