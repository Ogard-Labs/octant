export const FILE_HELPER_PROTOCOL_VERSION = 1;
export const FILE_HELPER_MAX_FRAME_BYTES = 1024 * 1024;
export const FILE_OPERATION_FAILURE_CODES = [
  "unavailable",
  "unauthorized",
  "unsupported",
  "waiting",
  "interrupted",
  "failed",
  "stale",
  "invalid",
  "conflict",
  "malformed",
  "oversized",
  "unknown",
  "eof",
  "not-found",
  "not-regular",
  "symlink",
  "hardlink",
  "identity-mismatch",
  "digest-mismatch",
  "device-mismatch",
  "cancelled",
  "escaped",
  "rootMismatch",
  "notFound",
  "deviceMismatch",
  "identityMismatch",
  "digestMismatch",
  "invalidType",
  "alreadyExists",
  "raced",
  "root-mismatch",
  "invalid-type",
  "already-exists",
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface FileHelperTransport {
  write(frame: Uint8Array): void | Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onExit(listener: () => void): () => void;
}

type RequestRoot = Readonly<{
  rootPath: string;
  rootIdentity: FileIdentity;
  pathComponents: readonly string[];
}>;

export type FileOperationRequest =
  | Readonly<RequestRoot & { operation: "inspect" }>
  | Readonly<RequestRoot & { operation: "startRead" }>
  | Readonly<RequestRoot & { operation: "readChunk"; sessionId: string; maximumBytes: number }>
  | Readonly<
      RequestRoot & {
        operation: "beginWrite";
        expectedIdentity: FileIdentity | null;
        expectedDigest: string | null;
      }
    >
  | Readonly<RequestRoot & { operation: "writeChunk"; uploadId: string; chunkBase64: string }>
  | Readonly<
      RequestRoot & {
        operation: "commitWrite";
        uploadId: string;
        expectedLength: number;
        expectedDigest: string;
      }
    >
  | Readonly<
      RequestRoot & {
        operation: "rename";
        destinationPathComponents: readonly string[];
        expectedIdentity: FileIdentity;
        expectedDigest: string;
      }
    >
  | Readonly<
      RequestRoot & {
        operation: "delete";
        expectedIdentity: FileIdentity;
        expectedDigest: string;
      }
    >
  | Readonly<RequestRoot & { operation: "cancelSession"; sessionId: string }>;

export type FileOperationFailureCode = (typeof FILE_OPERATION_FAILURE_CODES)[number];
export type FileOperationFailure = Readonly<{ code: FileOperationFailureCode }>;
export type FileOperationResponse =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; failure: FileOperationFailure }>;

export class FileHelperProtocolError extends Error {
  readonly code: "malformed" | "oversized";

  constructor(code: FileHelperProtocolError["code"]) {
    super(code);
    this.name = "FileHelperProtocolError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly resolve: (response: FileOperationResponse) => void;
  readonly cancel: () => void;
}

interface DecodedResponse {
  readonly correlationId: string;
  readonly response: FileOperationResponse;
}

const baseRequestKeys = [
  "protocolVersion",
  "correlationId",
  "operation",
  "rootPath",
  "rootIdentity",
  "pathComponents",
] as const;

const operationKeys: Readonly<Record<FileOperationRequest["operation"], readonly string[]>> = {
  inspect: baseRequestKeys,
  startRead: baseRequestKeys,
  readChunk: [...baseRequestKeys, "sessionId", "maximumBytes"],
  beginWrite: [...baseRequestKeys, "expectedIdentity", "expectedDigest"],
  writeChunk: [...baseRequestKeys, "uploadId", "chunkBase64"],
  commitWrite: [...baseRequestKeys, "uploadId", "expectedLength", "expectedDigest"],
  rename: [...baseRequestKeys, "destinationPathComponents", "expectedIdentity", "expectedDigest"],
  delete: [...baseRequestKeys, "expectedIdentity", "expectedDigest"],
  cancelSession: [...baseRequestKeys, "sessionId"],
};

export function encodeFileHelperFrame(value: unknown): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new FileHelperProtocolError("malformed");
  }
  if (json === undefined) throw new FileHelperProtocolError("malformed");
  const payload = encoder.encode(json);
  if (payload.byteLength > FILE_HELPER_MAX_FRAME_BYTES) {
    throw new FileHelperProtocolError("oversized");
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** A server-only stdio protocol port; all filesystem authority remains in the native helper. */
export class FileOperationPort {
  readonly #transport: FileHelperTransport;
  readonly #newCorrelationId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  #input: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #terminalFailure: FileOperationFailure | undefined;

  constructor(transport: FileHelperTransport, newCorrelationId: () => string = crypto.randomUUID) {
    this.#transport = transport;
    this.#newCorrelationId = newCorrelationId;
    transport.onData((chunk) => this.#receive(chunk));
    transport.onExit(() => this.#failAll({ code: "interrupted" }));
  }

  execute(input: FileOperationRequest, signal?: AbortSignal): Promise<FileOperationResponse> {
    if (this.#terminalFailure !== undefined)
      return Promise.resolve({ ok: false, failure: this.#terminalFailure });
    const prepared = prepareRequest(input, this.#newCorrelationId());
    if ("failure" in prepared) return Promise.resolve({ ok: false, failure: prepared.failure });
    if (signal?.aborted) return Promise.resolve({ ok: false, failure: { code: "interrupted" } });

    let frame: Uint8Array;
    try {
      frame = encodeFileHelperFrame(prepared.value);
    } catch (error) {
      return Promise.resolve({
        ok: false,
        failure: { code: error instanceof FileHelperProtocolError ? error.code : "malformed" },
      });
    }

    return new Promise((resolve) => {
      const cancel = () =>
        this.#settle(prepared.correlationId, { ok: false, failure: { code: "interrupted" } });
      signal?.addEventListener("abort", cancel, { once: true });
      this.#pending.set(prepared.correlationId, {
        resolve,
        cancel: () => signal?.removeEventListener("abort", cancel),
      });
      try {
        Promise.resolve(this.#transport.write(frame)).catch(() => {
          this.#settle(prepared.correlationId, { ok: false, failure: { code: "interrupted" } });
        });
      } catch {
        this.#settle(prepared.correlationId, { ok: false, failure: { code: "interrupted" } });
      }
    });
  }

  #receive(chunk: Uint8Array): void {
    if (this.#terminalFailure !== undefined) return;
    if (!(chunk instanceof Uint8Array)) {
      this.#failAll({ code: "malformed" });
      return;
    }
    this.#input = join(this.#input, chunk);
    while (this.#input.byteLength >= 4) {
      const length = new DataView(this.#input.buffer, this.#input.byteOffset, 4).getUint32(
        0,
        false,
      );
      if (length > FILE_HELPER_MAX_FRAME_BYTES) {
        this.#failAll({ code: "oversized" });
        return;
      }
      if (this.#input.byteLength < 4 + length) return;
      const payload = this.#input.slice(4, 4 + length);
      this.#input = this.#input.slice(4 + length);
      let decoded: DecodedResponse;
      try {
        decoded = decodeResponse(JSON.parse(decoder.decode(payload)));
      } catch {
        this.#failAll({ code: "malformed" });
        return;
      }
      this.#settle(decoded.correlationId, decoded.response);
    }
  }

  #settle(correlationId: string, response: FileOperationResponse): void {
    const pending = this.#pending.get(correlationId);
    if (pending === undefined) return;
    this.#pending.delete(correlationId);
    pending.cancel();
    pending.resolve(response);
  }

  #failAll(failure: FileOperationFailure): void {
    if (this.#terminalFailure !== undefined) return;
    this.#terminalFailure = failure;
    for (const correlationId of this.#pending.keys()) {
      this.#settle(correlationId, { ok: false, failure });
    }
  }
}

function prepareRequest(
  input: unknown,
  correlationId: string,
):
  | Readonly<{ correlationId: string; value: Record<string, unknown> }>
  | Readonly<{ failure: FileOperationFailure }> {
  if (!isNonEmptyString(correlationId)) return { failure: { code: "malformed" } };
  if (!isRecord(input) || typeof input.operation !== "string")
    return { failure: { code: "malformed" } };
  if (!Object.hasOwn(operationKeys, input.operation)) return { failure: { code: "unknown" } };
  const operation = input.operation as FileOperationRequest["operation"];
  if (
    !hasExactlyKeys(
      input,
      operationKeys[operation].filter(
        (key) => key !== "protocolVersion" && key !== "correlationId",
      ),
    ) ||
    !validRoot(input)
  ) {
    return { failure: { code: "malformed" } };
  }
  if (!validOperation(input, operation)) return { failure: { code: "malformed" } };
  return {
    correlationId,
    value: {
      protocolVersion: FILE_HELPER_PROTOCOL_VERSION,
      correlationId,
      ...input,
    },
  };
}

function decodeResponse(value: unknown): DecodedResponse {
  if (
    !isRecord(value) ||
    value.protocolVersion !== FILE_HELPER_PROTOCOL_VERSION ||
    !isNonEmptyString(value.correlationId) ||
    typeof value.ok !== "boolean"
  ) {
    throw new FileHelperProtocolError("malformed");
  }
  if (
    value.ok === true &&
    hasExactlyKeys(value, ["protocolVersion", "correlationId", "ok", "result"])
  ) {
    return { correlationId: value.correlationId, response: { ok: true, result: value.result } };
  }
  if (
    value.ok === false &&
    hasExactlyKeys(value, ["protocolVersion", "correlationId", "ok", "failure"]) &&
    isRecord(value.failure) &&
    hasExactlyKeys(value.failure, ["code"]) &&
    isFileOperationFailureCode(value.failure.code)
  ) {
    return {
      correlationId: value.correlationId,
      response: { ok: false, failure: { code: normalizeFailureCode(value.failure.code) } },
    };
  }
  throw new FileHelperProtocolError("malformed");
}

function normalizeFailureCode(code: FileOperationFailureCode): FileOperationFailureCode {
  switch (code) {
    case "rootMismatch":
      return "root-mismatch";
    case "notFound":
      return "not-found";
    case "deviceMismatch":
      return "device-mismatch";
    case "identityMismatch":
      return "identity-mismatch";
    case "digestMismatch":
      return "digest-mismatch";
    case "invalidType":
      return "invalid-type";
    case "alreadyExists":
      return "already-exists";
    case "raced":
      return "conflict";
    default:
      return code;
  }
}

function isFileOperationFailureCode(value: unknown): value is FileOperationFailureCode {
  return (
    typeof value === "string" &&
    FILE_OPERATION_FAILURE_CODES.includes(value as FileOperationFailureCode)
  );
}

function validRoot(input: Record<string, unknown>): boolean {
  return (
    isAbsolutePath(input.rootPath) &&
    validIdentity(input.rootIdentity) &&
    validPathComponents(input.pathComponents)
  );
}

function validOperation(
  input: Record<string, unknown>,
  operation: FileOperationRequest["operation"],
): boolean {
  switch (operation) {
    case "inspect":
    case "startRead":
      return true;
    case "readChunk":
      return (
        isNonEmptyString(input.sessionId) &&
        validLength(input.maximumBytes, FILE_HELPER_MAX_FRAME_BYTES)
      );
    case "beginWrite":
      return (
        validOptionalIdentity(input.expectedIdentity) && validOptionalDigest(input.expectedDigest)
      );
    case "writeChunk":
      return isNonEmptyString(input.uploadId) && validBase64(input.chunkBase64);
    case "commitWrite":
      return (
        isNonEmptyString(input.uploadId) &&
        validLength(input.expectedLength, Number.MAX_SAFE_INTEGER) &&
        validDigest(input.expectedDigest)
      );
    case "rename":
      return (
        validPathComponents(input.destinationPathComponents) &&
        validIdentity(input.expectedIdentity) &&
        validDigest(input.expectedDigest)
      );
    case "delete":
      return validIdentity(input.expectedIdentity) && validDigest(input.expectedDigest);
    case "cancelSession":
      return isNonEmptyString(input.sessionId);
  }
}

function validIdentity(value: unknown): value is FileIdentity {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["device", "inode"]) &&
    isNonEmptyString(value.device) &&
    isNonEmptyString(value.inode)
  );
}

function validOptionalIdentity(value: unknown): boolean {
  return value === null || validIdentity(value);
}

function validPathComponents(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 1_024) return false;
  let totalBytes = 0;
  for (const component of value) {
    if (
      !isNonEmptyString(component) ||
      component === "." ||
      component === ".." ||
      component.includes("/") ||
      component.includes("\\") ||
      component.includes("\0") ||
      component !== component.normalize("NFC")
    ) {
      return false;
    }
    const componentBytes = encoder.encode(component).byteLength;
    if (componentBytes > 255) return false;
    totalBytes += componentBytes + (totalBytes === 0 ? 0 : 1);
    if (totalBytes > 4_096) return false;
  }
  return true;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validOptionalDigest(value: unknown): boolean {
  return value === null || validDigest(value);
}

function validBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function validLength(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isAbsolutePath(value: unknown): value is string {
  return isNonEmptyString(value) && value.startsWith("/") && !value.includes("\0");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  const value = new Uint8Array(left.byteLength + right.byteLength);
  value.set(left);
  value.set(right, left.byteLength);
  return value;
}
