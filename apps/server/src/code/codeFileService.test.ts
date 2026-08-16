import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeContentStore } from "./codeContentStore";
import {
  CODE_FILE_CHUNK_BYTES,
  MAX_EDITABLE_CODE_FILE_BYTES,
  MAX_SEARCH_CODE_FILE_BYTES,
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_RESULT_BYTES,
  CodeFileService,
  type CodeFileOperationPort,
  type CodeFileOperationRequest,
} from "./codeFileService";
import type {
  FileIdentity,
  FileOperationFailureCode,
  FileOperationResponse,
} from "./fileOperationPort";

const encoder = new TextEncoder();
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const root = {
  rootPath: "/private/workspace",
  rootIdentity: { device: "1", inode: "2" },
} as const;
const originalIdentity = { device: "1", inode: "3" } as const;

class FakeFilePort implements CodeFileOperationPort {
  readonly calls: CodeFileOperationRequest[] = [];
  readonly cancelledSessions: string[] = [];
  bytes: Uint8Array;
  identity: FileIdentity = originalIdentity;
  metadataLengthOverride?: number;
  failOperation?: CodeFileOperationRequest["operation"];
  failureCode: FileOperationFailureCode = "interrupted";
  mutateBeforeBegin = false;
  mismatchVerification = false;
  onBeginWrite?: () => void;
  #readOffset = 0;
  #upload: Uint8Array[] = [];

  constructor(bytes: Uint8Array | string) {
    this.bytes = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  }

  async execute(
    input: CodeFileOperationRequest,
    signal?: AbortSignal,
  ): Promise<FileOperationResponse> {
    this.calls.push(input);
    if (signal?.aborted || input.operation === this.failOperation) {
      return { ok: false, failure: { code: this.failureCode } };
    }
    const metadata = () => ({
      identity: this.identity,
      byteLength: this.metadataLengthOverride ?? this.bytes.byteLength,
      modifiedNanoseconds: "123",
      digest: this.mismatchVerification ? "f".repeat(64) : digest(this.bytes),
    });

    switch (input.operation) {
      case "inspect":
        return { ok: true, result: { metadata: metadata() } };
      case "startRead":
        this.#readOffset = 0;
        return {
          ok: true,
          result: {
            sessionId: "00000000-0000-4000-8000-000000000001",
            totalLength: this.bytes.byteLength,
            metadata: metadata(),
          },
        };
      case "readChunk": {
        const offset = this.#readOffset;
        const chunk = this.bytes.slice(offset, offset + input.maximumBytes);
        this.#readOffset += chunk.byteLength;
        return {
          ok: true,
          result: {
            offset,
            dataBase64: Buffer.from(chunk).toString("base64"),
            eof: this.#readOffset === this.bytes.byteLength,
          },
        };
      }
      case "beginWrite":
        if (this.mutateBeforeBegin) this.identity = { device: "1", inode: "99" };
        if (
          input.expectedIdentity.device !== this.identity.device ||
          input.expectedIdentity.inode !== this.identity.inode
        ) {
          return { ok: false, failure: { code: "identity-mismatch" } };
        }
        if (input.expectedDigest !== digest(this.bytes)) {
          return { ok: false, failure: { code: "digest-mismatch" } };
        }
        this.#upload = [];
        this.onBeginWrite?.();
        return {
          ok: true,
          result: { uploadId: "10000000-0000-4000-8000-000000000001" },
        };
      case "writeChunk":
        this.#upload.push(Uint8Array.from(Buffer.from(input.chunkBase64, "base64")));
        return {
          ok: true,
          result: {
            acceptedLength: this.#upload.reduce((total, chunk) => total + chunk.byteLength, 0),
          },
        };
      case "commitWrite": {
        const bytes = Uint8Array.from(this.#upload.flatMap((chunk) => [...chunk]));
        if (bytes.byteLength !== input.expectedLength || digest(bytes) !== input.expectedDigest) {
          return { ok: false, failure: { code: "digest-mismatch" } };
        }
        this.bytes = bytes;
        this.identity = { device: "1", inode: "4" };
        return {
          ok: true,
          result: { byteLength: bytes.byteLength, digest: digest(bytes) },
        };
      }
      case "cancelSession":
        this.cancelledSessions.push(input.sessionId);
        this.#upload = [];
        return { ok: true, result: {} };
    }
  }
}

function fixture(bytes: Uint8Array | string, maximumStoreBytes = 40 * 1024 * 1024) {
  let nextId = 0;
  const port = new FakeFilePort(bytes);
  const content = new CodeContentStore({
    maximumBytes: maximumStoreBytes,
    maximumEntries: 16,
    newContentId: () => `content-${++nextId}`,
  });
  return { port, content, service: new CodeFileService({ port, content }) };
}

describe("CodeFileService paths", () => {
  it.each([
    "",
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src//file.ts",
    "src\\file.ts",
    "src/./file.ts",
    "src/file.ts/",
    "src/\0file.ts",
    "e\u0301.txt",
    `${"a".repeat(256)}.ts`,
  ])("rejects non-canonical path %j before invoking the helper", async (path) => {
    const { port, service } = fixture("safe");

    await expect(service.open({ ...root, path })).resolves.toMatchObject({
      status: "failed",
      failure: { category: "invalid" },
    });
    expect(port.calls).toEqual([]);
  });

  it.each(["symlink", "hardlink", "device-mismatch", "invalid"] as const)(
    "fails closed when the helper rejects %s authority",
    async (failureCode) => {
      const { port, service } = fixture("safe");
      port.failOperation = "inspect";
      port.failureCode = failureCode;

      await expect(service.open({ ...root, path: "src/file.ts" })).resolves.toMatchObject({
        status: "failed",
        failure: { code: failureCode },
      });
    },
  );
});

describe("CodeFileService.open", () => {
  it("retains valid UTF-8 at the inclusive 5 MiB editing limit", async () => {
    const bytes = new Uint8Array(MAX_EDITABLE_CODE_FILE_BYTES).fill(0x61);
    const { content, service } = fixture(bytes);

    const result = await service.open({ ...root, path: "large.txt" });

    expect(result).toMatchObject({ status: "editable", metadata: { byteLength: bytes.length } });
    if (result.status !== "editable") throw new Error("expected editable result");
    // Avoid vitest deep equality on multi-MiB TypedArrays — it is multi-second
    // and flakes under CI's 30s server-test budget.
    const retained = content.get(result.content.contentId);
    expect(retained.byteLength).toBe(bytes.byteLength);
    expect(Buffer.compare(retained, bytes)).toBe(0);
  });

  it("exposes metadata only for files larger than 5 MiB", async () => {
    const { port, content, service } = fixture("not-read");
    port.metadataLengthOverride = MAX_EDITABLE_CODE_FILE_BYTES + 1;

    await expect(service.open({ ...root, path: "large.bin" })).resolves.toMatchObject({
      status: "read-only",
      reason: "too-large",
    });
    expect(port.calls.map((call) => call.operation)).toEqual(["inspect"]);
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("exposes metadata only and purges buffered bytes for invalid UTF-8", async () => {
    const { content, service } = fixture(new Uint8Array([0x66, 0x80, 0x6f]));

    await expect(service.open({ ...root, path: "binary.dat" })).resolves.toMatchObject({
      status: "read-only",
      reason: "binary",
    });
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("treats NUL-bearing valid UTF-8 as binary metadata-only content", async () => {
    const { content, service } = fixture(new Uint8Array([0x00, 0x61]));

    await expect(service.open({ ...root, path: "binary.dat" })).resolves.toMatchObject({
      status: "read-only",
      reason: "binary",
    });
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });
});

describe("CodeFileService.search", () => {
  it("returns normalized bounded JSONL matches in the content store", async () => {
    const { content, service } = fixture("alpha e\u0301\nalpha é\nnone");

    const result = await service.search({ ...root, path: "notes.txt", query: "alpha" });

    expect(result).toMatchObject({ status: "completed", matchCount: 2, truncated: false });
    if (result.status !== "completed") throw new Error("expected completed result");
    const output = new TextDecoder().decode(content.get(result.content.contentId));
    expect(output).toContain('"line":1');
    expect(output).toContain('"line":2');
    expect(output).toBe(output.normalize("NFC"));
    expect(result.content.byteLength).toBeLessThanOrEqual(MAX_SEARCH_RESULT_BYTES);
  });

  it("does not scan files larger than the inclusive 20 MiB limit", async () => {
    const { port, service } = fixture("not-read");
    port.metadataLengthOverride = MAX_SEARCH_CODE_FILE_BYTES + 1;

    await expect(
      service.search({ ...root, path: "vendor/bundle.js", query: "needle" }),
    ).resolves.toMatchObject({ status: "read-only", reason: "too-large" });
    expect(port.calls.map((call) => call.operation)).toEqual(["inspect"]);
  });

  it("rejects binary search targets and purges buffered bytes", async () => {
    const { content, service } = fixture(new Uint8Array([0x00, 0x80, 0xff]));

    await expect(
      service.search({ ...root, path: "image.bin", query: "needle" }),
    ).resolves.toMatchObject({ status: "read-only", reason: "binary" });
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("caps match count at 10,000 and marks additional matches truncated", async () => {
    const { service } = fixture("x\n".repeat(MAX_SEARCH_MATCHES + 1));

    await expect(service.search({ ...root, path: "many.txt", query: "x" })).resolves.toMatchObject({
      status: "completed",
      matchCount: MAX_SEARCH_MATCHES,
      truncated: true,
    });
  });

  it("caps normalized result bytes at 2 MiB", async () => {
    const line = `${"p".repeat(300)}x\n`;
    const { content, service } = fixture(line.repeat(MAX_SEARCH_MATCHES));

    const result = await service.search({ ...root, path: "wide.txt", query: "x" });

    expect(result).toMatchObject({ status: "completed", truncated: true });
    if (result.status !== "completed") throw new Error("expected completed result");
    expect(result.content.byteLength).toBeLessThanOrEqual(MAX_SEARCH_RESULT_BYTES);
    expect(content.get(result.content.contentId).byteLength).toBe(result.content.byteLength);
  });
});

describe("CodeFileService.save", () => {
  it("requires expected identity and digest, uploads in bounded chunks, commits, and verifies", async () => {
    const original = "before";
    const next = "a".repeat(MAX_EDITABLE_CODE_FILE_BYTES);
    const { port, content, service } = fixture(original);

    const result = await service.save({
      ...root,
      path: "src/file.ts",
      text: next,
      expectedIdentity: originalIdentity,
      expectedDigest: digest(encoder.encode(original)),
    });

    expect(result).toMatchObject({ status: "completed", metadata: { byteLength: next.length } });
    const begin = port.calls.find((call) => call.operation === "beginWrite");
    expect(begin).toMatchObject({
      expectedIdentity: originalIdentity,
      expectedDigest: digest(encoder.encode(original)),
    });
    const chunks = port.calls.filter((call) => call.operation === "writeChunk");
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (call) =>
          call.operation === "writeChunk" &&
          Buffer.from(call.chunkBase64, "base64").byteLength <= CODE_FILE_CHUNK_BYTES,
      ),
    ).toBe(true);
    expect(port.calls.find((call) => call.operation === "commitWrite")).toMatchObject({
      expectedLength: MAX_EDITABLE_CODE_FILE_BYTES,
      expectedDigest: digest(encoder.encode(next)),
    });
    expect(port.calls.at(-1)?.operation).toBe("inspect");
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("returns a stale conflict without starting an upload", async () => {
    const { port, content, service } = fixture("before");
    port.mutateBeforeBegin = true;

    await expect(
      service.save({
        ...root,
        path: "src/file.ts",
        text: "after",
        expectedIdentity: originalIdentity,
        expectedDigest: digest(encoder.encode("before")),
      }),
    ).resolves.toMatchObject({ status: "conflict", failure: { code: "identity-mismatch" } });
    expect(port.calls.some((call) => call.operation === "writeChunk")).toBe(false);
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("cancels the owned upload, purges content, and requests rescan after interruption", async () => {
    const { port, content, service } = fixture("before");
    const controller = new AbortController();
    port.onBeginWrite = () => controller.abort();

    const result = await service.save({
      ...root,
      path: "src/file.ts",
      text: "after",
      expectedIdentity: originalIdentity,
      expectedDigest: digest(encoder.encode("before")),
      signal: controller.signal,
    });

    expect(result).toEqual({ status: "interrupted", rescanRequired: true });
    expect(port.cancelledSessions).toEqual(["10000000-0000-4000-8000-000000000001"]);
    expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("never reports completed when commit outcome or verification is ambiguous", async () => {
    const commitFixture = fixture("before");
    commitFixture.port.failOperation = "commitWrite";
    await expect(
      commitFixture.service.save({
        ...root,
        path: "src/file.ts",
        text: "after",
        expectedIdentity: originalIdentity,
        expectedDigest: digest(encoder.encode("before")),
      }),
    ).resolves.toEqual({ status: "interrupted", rescanRequired: true });

    const verifyFixture = fixture("before");
    verifyFixture.port.mismatchVerification = true;
    await expect(
      verifyFixture.service.save({
        ...root,
        path: "src/file.ts",
        text: "after",
        expectedIdentity: originalIdentity,
        expectedDigest: digest(encoder.encode("before")),
      }),
    ).resolves.toEqual({ status: "interrupted", rescanRequired: true });
  });

  it("rejects invalid UTF-8 scalar text and files over 5 MiB before invoking the helper", async () => {
    for (const text of ["\ud800", "a".repeat(MAX_EDITABLE_CODE_FILE_BYTES + 1)]) {
      const { port, content, service } = fixture("before");
      await expect(
        service.save({
          ...root,
          path: "src/file.ts",
          text,
          expectedIdentity: originalIdentity,
          expectedDigest: digest(encoder.encode("before")),
        }),
      ).resolves.toMatchObject({ status: "failed", failure: { category: "invalid" } });
      expect(port.calls).toEqual([]);
      expect(content.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
    }
  });
});
