import { describe, expect, it } from "vitest";
import {
  FILE_HELPER_MAX_FRAME_BYTES,
  FILE_HELPER_PROTOCOL_VERSION,
  FileOperationPort,
  encodeFileHelperFrame,
  type FileHelperTransport,
} from "./fileOperationPort";

class FakeHelper implements FileHelperTransport {
  readonly writes: Uint8Array[] = [];
  #dataListener: ((chunk: Uint8Array) => void) | undefined;
  #exitListener: (() => void) | undefined;

  write(frame: Uint8Array): void {
    this.writes.push(frame);
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.#dataListener = listener;
    return () => {
      this.#dataListener = undefined;
    };
  }

  onExit(listener: () => void): () => void {
    this.#exitListener = listener;
    return () => {
      this.#exitListener = undefined;
    };
  }

  send(message: unknown, splits: readonly number[] = []): void {
    const frame = encodeFileHelperFrame(message);
    let offset = 0;
    for (const size of splits) {
      this.#dataListener?.(frame.slice(offset, offset + size));
      offset += size;
    }
    this.#dataListener?.(frame.slice(offset));
  }

  receive(chunk: Uint8Array): void {
    this.#dataListener?.(chunk);
  }

  exit(): void {
    this.#exitListener?.();
  }
}

function decode(frame: Uint8Array): unknown {
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(frame.slice(4, 4 + length)));
}

const root = {
  rootPath: "/private/workspace",
  rootIdentity: { device: "1", inode: "2" },
  pathComponents: ["src", "main.ts"],
} as const;

describe("FileOperationPort", () => {
  it("writes strict versioned big-endian frames and resolves partial and coalesced replies", async () => {
    const helper = new FakeHelper();
    let correlation = 0;
    const port = new FileOperationPort(helper, () => `correlation-${++correlation}`);
    const pending = port.execute({ operation: "inspect", ...root });

    expect(decode(helper.writes[0]!)).toEqual({
      protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
      correlationId: "correlation-1",
      operation: "inspect",
      ...root,
    });

    helper.send(
      {
        protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
        correlationId: "correlation-1",
        ok: true,
        result: { kind: "file", length: 12 },
      },
      [1, 2, 4],
    );
    await expect(pending).resolves.toEqual({ ok: true, result: { kind: "file", length: 12 } });

    const second = port.execute({ operation: "startRead", ...root });
    const third = port.execute({
      operation: "readChunk",
      ...root,
      sessionId: "read-1",
      maximumBytes: 1024,
    });
    const replies = new Uint8Array([
      ...encodeFileHelperFrame({
        protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
        correlationId: "correlation-2",
        ok: true,
        result: { sessionId: "read-1" },
      }),
      ...encodeFileHelperFrame({
        protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
        correlationId: "correlation-3",
        ok: false,
        failure: { code: "eof" },
      }),
    ]);
    helper.receive(replies);

    await expect(second).resolves.toEqual({ ok: true, result: { sessionId: "read-1" } });
    await expect(third).resolves.toEqual({ ok: false, failure: { code: "eof" } });
  });

  it("serializes chunked reads and exclusive temp uploads with expected identities and digests", () => {
    const helper = new FakeHelper();
    const port = new FileOperationPort(helper, () => "correlation-two");

    void port.execute({ operation: "startRead", ...root });
    void port.execute({ operation: "readChunk", ...root, sessionId: "read-1", maximumBytes: 1024 });
    void port.execute({
      operation: "beginWrite",
      ...root,
      expectedIdentity: { device: "1", inode: "3" },
      expectedDigest: "a".repeat(64),
    });
    void port.execute({
      operation: "writeChunk",
      ...root,
      uploadId: "upload-1",
      chunkBase64: "aGVsbG8=",
    });
    void port.execute({
      operation: "commitWrite",
      ...root,
      uploadId: "upload-1",
      expectedLength: 5,
      expectedDigest: "b".repeat(64),
    });
    void port.execute({
      operation: "rename",
      ...root,
      destinationPathComponents: ["src", "renamed.ts"],
      expectedIdentity: { device: "1", inode: "3" },
      expectedDigest: "c".repeat(64),
    });
    void port.execute({
      operation: "delete",
      ...root,
      expectedIdentity: { device: "1", inode: "3" },
      expectedDigest: "d".repeat(64),
    });
    void port.execute({ operation: "cancelSession", ...root, sessionId: "upload-1" });

    expect(helper.writes.map(decode)).toEqual([
      expect.objectContaining({ operation: "startRead", ...root }),
      expect.objectContaining({
        operation: "readChunk",
        ...root,
        sessionId: "read-1",
        maximumBytes: 1024,
      }),
      expect.objectContaining({
        operation: "beginWrite",
        ...root,
        expectedIdentity: { device: "1", inode: "3" },
        expectedDigest: "a".repeat(64),
      }),
      expect.objectContaining({
        operation: "writeChunk",
        ...root,
        uploadId: "upload-1",
        chunkBase64: "aGVsbG8=",
      }),
      expect.objectContaining({
        operation: "commitWrite",
        ...root,
        uploadId: "upload-1",
        expectedLength: 5,
        expectedDigest: "b".repeat(64),
      }),
      expect.objectContaining({
        operation: "rename",
        ...root,
        destinationPathComponents: ["src", "renamed.ts"],
        expectedIdentity: { device: "1", inode: "3" },
        expectedDigest: "c".repeat(64),
      }),
      expect.objectContaining({
        operation: "delete",
        ...root,
        expectedIdentity: { device: "1", inode: "3" },
        expectedDigest: "d".repeat(64),
      }),
      expect.objectContaining({ operation: "cancelSession", ...root, sessionId: "upload-1" }),
    ]);
  });

  it("fails unknown or malformed requests locally without invoking the helper", async () => {
    const helper = new FakeHelper();
    const port = new FileOperationPort(helper, () => "correlation-three");

    await expect(
      port.execute({ operation: "inspect", ...root, pathComponents: [".."] } as never),
    ).resolves.toEqual({ ok: false, failure: { code: "malformed" } });
    await expect(
      port.execute({ operation: "not-an-operation", ...root } as never),
    ).resolves.toEqual({ ok: false, failure: { code: "unknown" } });
    await expect(
      port.execute({
        operation: "inspect",
        ...root,
        pathComponents: ["é".repeat(128)],
      }),
    ).resolves.toEqual({ ok: false, failure: { code: "malformed" } });
    expect(helper.writes).toEqual([]);
  });

  it("accepts the inclusive frame limit and rejects larger frames before transport", async () => {
    const exact = { value: "x".repeat(FILE_HELPER_MAX_FRAME_BYTES - 12) };
    expect(encodeFileHelperFrame(exact)).toHaveLength(FILE_HELPER_MAX_FRAME_BYTES + 4);
    expect(() => encodeFileHelperFrame({ value: "x".repeat(FILE_HELPER_MAX_FRAME_BYTES) })).toThrow(
      "oversized",
    );

    const helper = new FakeHelper();
    const port = new FileOperationPort(helper, () => "correlation-four");
    await expect(
      port.execute({
        operation: "writeChunk",
        ...root,
        uploadId: "upload-1",
        chunkBase64: "x".repeat(FILE_HELPER_MAX_FRAME_BYTES),
      }),
    ).resolves.toEqual({ ok: false, failure: { code: "oversized" } });
    expect(helper.writes).toEqual([]);
  });

  it("turns malformed or oversized helper frames, helper death, and cancellation into typed failures", async () => {
    const helper = new FakeHelper();
    const port = new FileOperationPort(helper, () => "correlation-five");
    const malformed = port.execute({ operation: "inspect", ...root });
    helper.send({ protocolVersion: 99, correlationId: "correlation-five", ok: true, result: {} });
    await expect(malformed).resolves.toEqual({ ok: false, failure: { code: "malformed" } });

    const unknownFailureHelper = new FakeHelper();
    const unknownFailurePort = new FileOperationPort(
      unknownFailureHelper,
      () => "correlation-unknown-failure",
    );
    const unknownFailure = unknownFailurePort.execute({ operation: "inspect", ...root });
    unknownFailureHelper.send({
      protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
      correlationId: "correlation-unknown-failure",
      ok: false,
      failure: { code: "arbitrary-native-message" },
    });
    await expect(unknownFailure).resolves.toEqual({
      ok: false,
      failure: { code: "malformed" },
    });

    const nativeFailureHelper = new FakeHelper();
    const nativeFailurePort = new FileOperationPort(
      nativeFailureHelper,
      () => "correlation-native-failure",
    );
    const nativeFailure = nativeFailurePort.execute({ operation: "inspect", ...root });
    nativeFailureHelper.send({
      protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
      correlationId: "correlation-native-failure",
      ok: false,
      failure: { code: "digestMismatch" },
    });
    await expect(nativeFailure).resolves.toEqual({
      ok: false,
      failure: { code: "digest-mismatch" },
    });

    const oversizedHelper = new FakeHelper();
    const oversizedPort = new FileOperationPort(oversizedHelper, () => "correlation-oversized");
    const oversized = oversizedPort.execute({ operation: "inspect", ...root });
    oversizedHelper.receive(new Uint8Array([0, 16, 0, 1]));
    await expect(oversized).resolves.toEqual({ ok: false, failure: { code: "oversized" } });

    const diedHelper = new FakeHelper();
    const diedPort = new FileOperationPort(diedHelper, () => "correlation-died");
    const died = diedPort.execute({ operation: "inspect", ...root });
    diedHelper.exit();
    await expect(died).resolves.toEqual({ ok: false, failure: { code: "interrupted" } });

    const cancelledHelper = new FakeHelper();
    const cancelledPort = new FileOperationPort(cancelledHelper, () => "correlation-six");
    const controller = new AbortController();
    const cancelled = cancelledPort.execute({ operation: "inspect", ...root }, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toEqual({ ok: false, failure: { code: "interrupted" } });
  });
});
