import { createHash } from "node:crypto";
import type { CodeFileListingResult } from "@octant/contracts";
import type { FileIdentity, FileOperationResponse } from "./fileOperationPort";
import type { CodeFileListingRequest } from "./codeFileListingService";
import {
  CodeContentStore,
  CodeContentStoreError,
  type CodeContentReference,
} from "./codeContentStore";

export const MAX_EDITABLE_CODE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SEARCH_CODE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SEARCH_MATCHES = 10_000;
export const MAX_SEARCH_RESULT_BYTES = 2 * 1024 * 1024;
export const CODE_FILE_CHUNK_BYTES = 512 * 1024;

const MAX_CODE_RELATIVE_PATH_BYTES = 4_096;
const MAX_CODE_PATH_COMPONENT_BYTES = 255;
const MAX_SEARCH_QUERY_BYTES = 4_096;
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

type FileRequestRoot = Readonly<{
  rootPath: string;
  rootIdentity: FileIdentity;
  pathComponents: readonly string[];
}>;

export type CodeFileOperationRequest =
  | Readonly<FileRequestRoot & { operation: "inspect" }>
  | Readonly<FileRequestRoot & { operation: "startRead" }>
  | Readonly<
      FileRequestRoot & {
        operation: "readChunk";
        sessionId: string;
        maximumBytes: number;
      }
    >
  | Readonly<
      FileRequestRoot & {
        operation: "beginWrite";
        expectedIdentity: FileIdentity;
        expectedDigest: string;
      }
    >
  | Readonly<
      FileRequestRoot & {
        operation: "writeChunk";
        uploadId: string;
        chunkBase64: string;
      }
    >
  | Readonly<
      FileRequestRoot & {
        operation: "commitWrite";
        uploadId: string;
        expectedLength: number;
        expectedDigest: string;
      }
    >
  | Readonly<FileRequestRoot & { operation: "cancelSession"; sessionId: string }>;

export interface CodeFileOperationPort {
  execute(input: CodeFileOperationRequest, signal?: AbortSignal): Promise<FileOperationResponse>;
}

export interface CodeFileMetadata {
  readonly identity: FileIdentity;
  readonly byteLength: number;
  readonly modifiedNanoseconds: string;
  readonly digest: string;
}

export interface CodeFileLocation {
  readonly rootPath: string;
  readonly rootIdentity: FileIdentity;
  readonly path: string;
}

export interface CodeFileFailure {
  readonly category: "conflict" | "failed" | "invalid" | "unavailable";
  readonly code: string;
}

export type CodeFileOpenResult =
  | Readonly<{
      status: "editable";
      metadata: CodeFileMetadata;
      content: CodeContentReference;
    }>
  | Readonly<{
      status: "read-only";
      metadata: CodeFileMetadata;
      reason: "binary" | "too-large";
    }>
  | Readonly<{ status: "interrupted"; rescanRequired: true }>
  | Readonly<{ status: "failed"; failure: CodeFileFailure }>;

export type CodeFileSearchResult =
  | Readonly<{
      status: "completed";
      metadata: CodeFileMetadata;
      matchCount: number;
      truncated: boolean;
      content: CodeContentReference;
    }>
  | Readonly<{
      status: "read-only";
      metadata: CodeFileMetadata;
      reason: "binary" | "too-large";
    }>
  | Readonly<{ status: "interrupted"; rescanRequired: true }>
  | Readonly<{ status: "failed"; failure: CodeFileFailure }>;

export type CodeFileSaveResult =
  | Readonly<{ status: "completed"; metadata: CodeFileMetadata }>
  | Readonly<{ status: "conflict"; failure: CodeFileFailure }>
  | Readonly<{ status: "interrupted"; rescanRequired: true }>
  | Readonly<{ status: "failed"; failure: CodeFileFailure }>;

/**
 * Read-only listing capability, kept structural so `CodeFileService` does not
 * import the listing implementation at runtime. Listing needs no file helper:
 * it reads directory entries under the bound checkout directly, which is why a
 * host whose helper transport failed can still populate the file explorer.
 */
export interface CodeFileListingPort {
  list(request: CodeFileListingRequest): Promise<CodeFileListingResult>;
}

export interface CodeFileServiceOptions {
  readonly port: CodeFileOperationPort;
  readonly content: CodeContentStore;
  readonly listing?: CodeFileListingPort;
}

type PreparedLocation = FileRequestRoot;
type ParsedPortResult<T> =
  | Readonly<{ status: "available"; value: T }>
  | Readonly<{ status: "failed"; code: string }>;

type ReadAllResult =
  | Readonly<{ status: "available"; metadata: CodeFileMetadata; bytes: Uint8Array }>
  | Readonly<{ status: "too-large"; metadata: CodeFileMetadata }>
  | Readonly<{ status: "failed"; code: string }>;

export class CodeFileService {
  readonly #port: CodeFileOperationPort;
  readonly #content: CodeContentStore;
  readonly #listing: CodeFileListingPort | undefined;

  constructor(options: CodeFileServiceOptions) {
    this.#port = options.port;
    this.#content = options.content;
    this.#listing = options.listing;
  }

  /**
   * List the confined checkout bound to a Code thread. Fails closed as
   * `unavailable` when no listing capability was supplied, so a host that never
   * wired one answers honestly instead of pretending the repository is empty.
   */
  async list(request: CodeFileListingRequest): Promise<CodeFileListingResult> {
    if (this.#listing === undefined) {
      return {
        status: "failed",
        failure: { category: "unavailable", message: "Code file listing is unavailable." },
      };
    }
    return await this.#listing.list(request);
  }

  async open(
    input: CodeFileLocation & Readonly<{ signal?: AbortSignal }>,
  ): Promise<CodeFileOpenResult> {
    const prepared = prepareLocation(input);
    if ("failure" in prepared) return prepared;

    const inspected = await this.#inspect(prepared.location, input.signal);
    if (inspected.status === "failed") return readFailure(inspected.code);
    if (inspected.value.byteLength > MAX_EDITABLE_CODE_FILE_BYTES) {
      return { status: "read-only", metadata: inspected.value, reason: "too-large" };
    }

    const read = await this.#readAll(prepared.location, MAX_EDITABLE_CODE_FILE_BYTES, input.signal);
    if (read.status === "failed") return readFailure(read.code);
    if (read.status === "too-large") {
      return { status: "read-only", metadata: read.metadata, reason: "too-large" };
    }
    if (decodeUtf8(read.bytes) === undefined) {
      return { status: "read-only", metadata: read.metadata, reason: "binary" };
    }
    try {
      return {
        status: "editable",
        metadata: read.metadata,
        content: this.#content.put(read.bytes),
      };
    } catch (error) {
      return contentFailure(error);
    }
  }

  async search(
    input: CodeFileLocation & Readonly<{ query: string; signal?: AbortSignal }>,
  ): Promise<CodeFileSearchResult> {
    const prepared = prepareLocation(input);
    if ("failure" in prepared) return prepared;
    if (!validSearchQuery(input.query)) return invalidFailure("invalid-query");

    const inspected = await this.#inspect(prepared.location, input.signal);
    if (inspected.status === "failed") return readFailure(inspected.code);
    if (inspected.value.byteLength > MAX_SEARCH_CODE_FILE_BYTES) {
      return { status: "read-only", metadata: inspected.value, reason: "too-large" };
    }

    const read = await this.#readAll(prepared.location, MAX_SEARCH_CODE_FILE_BYTES, input.signal);
    if (read.status === "failed") return readFailure(read.code);
    if (read.status === "too-large") {
      return { status: "read-only", metadata: read.metadata, reason: "too-large" };
    }
    const text = decodeUtf8(read.bytes);
    if (text === undefined) {
      return { status: "read-only", metadata: read.metadata, reason: "binary" };
    }

    const normalized = normalizeMatches(input.path, text, input.query);
    try {
      return {
        status: "completed",
        metadata: read.metadata,
        matchCount: normalized.matchCount,
        truncated: normalized.truncated,
        content: this.#content.put(normalized.bytes),
      };
    } catch (error) {
      return contentFailure(error);
    }
  }

  async save(
    input: CodeFileLocation &
      Readonly<{
        text: string;
        expectedIdentity: FileIdentity;
        expectedDigest: string;
        signal?: AbortSignal;
      }>,
  ): Promise<CodeFileSaveResult> {
    const prepared = prepareLocation(input);
    if ("failure" in prepared) return prepared;
    if (!validIdentity(input.expectedIdentity) || !validDigest(input.expectedDigest)) {
      return invalidFailure("invalid-expectation");
    }
    const bytes = encodeValidUtf8(input.text);
    if (bytes === undefined || bytes.byteLength > MAX_EDITABLE_CODE_FILE_BYTES) {
      return invalidFailure("invalid-content");
    }

    let content: CodeContentReference;
    try {
      content = this.#content.put(bytes);
    } catch (error) {
      return contentFailure(error);
    }

    let uploadId: string | undefined;
    try {
      const begun = await this.#execute(
        {
          ...prepared.location,
          operation: "beginWrite",
          expectedIdentity: input.expectedIdentity,
          expectedDigest: input.expectedDigest,
        },
        input.signal,
      );
      if (begun.status === "failed") return mutationFailure(begun.code);
      uploadId = parseIdentifierResult(begun.value, "uploadId");
      if (uploadId === undefined) return interrupted();

      const ownedBytes = this.#content.get(content.contentId);
      for (let offset = 0; offset < ownedBytes.byteLength; offset += CODE_FILE_CHUNK_BYTES) {
        const chunk = ownedBytes.slice(offset, offset + CODE_FILE_CHUNK_BYTES);
        const written = await this.#execute(
          {
            ...prepared.location,
            operation: "writeChunk",
            uploadId,
            chunkBase64: Buffer.from(chunk).toString("base64"),
          },
          input.signal,
        );
        if (written.status === "failed") return mutationFailure(written.code);
        const acceptedLength = parseAcceptedLength(written.value);
        if (acceptedLength !== offset + chunk.byteLength) return interrupted();
      }

      const committed = await this.#execute(
        {
          ...prepared.location,
          operation: "commitWrite",
          uploadId,
          expectedLength: content.byteLength,
          expectedDigest: content.digest,
        },
        input.signal,
      );
      if (committed.status === "failed") return mutationFailure(committed.code);
      const commitment = parseCommitResult(committed.value);
      if (
        commitment === undefined ||
        commitment.byteLength !== content.byteLength ||
        commitment.digest !== content.digest
      ) {
        return interrupted();
      }
      uploadId = undefined;

      const verified = await this.#inspect(prepared.location, input.signal);
      if (
        verified.status === "failed" ||
        verified.value.byteLength !== content.byteLength ||
        verified.value.digest !== content.digest
      ) {
        return interrupted();
      }
      return { status: "completed", metadata: verified.value };
    } finally {
      if (uploadId !== undefined) {
        await this.#execute({
          ...prepared.location,
          operation: "cancelSession",
          sessionId: uploadId,
        });
      }
      this.#content.purge(content.contentId);
    }
  }

  async #inspect(
    location: PreparedLocation,
    signal?: AbortSignal,
  ): Promise<ParsedPortResult<CodeFileMetadata>> {
    const response = await this.#execute({ ...location, operation: "inspect" }, signal);
    if (response.status === "failed") return response;
    const metadata = parseMetadataEnvelope(response.value);
    return metadata === undefined
      ? { status: "failed", code: "malformed" }
      : { status: "available", value: metadata };
  }

  async #readAll(
    location: PreparedLocation,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<ReadAllResult> {
    const started = await this.#execute({ ...location, operation: "startRead" }, signal);
    if (started.status === "failed") return started;
    const session = parseReadSession(started.value);
    if (session === undefined) return { status: "failed", code: "malformed" };
    let sessionOpen = true;
    try {
      if (session.totalLength > maximumBytes) {
        return { status: "too-large", metadata: session.metadata };
      }
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (sessionOpen) {
        const response = await this.#execute(
          {
            ...location,
            operation: "readChunk",
            sessionId: session.sessionId,
            maximumBytes: CODE_FILE_CHUNK_BYTES,
          },
          signal,
        );
        if (response.status === "failed") return response;
        const chunk = parseReadChunk(response.value);
        if (
          chunk === undefined ||
          chunk.offset !== received ||
          chunk.bytes.byteLength > CODE_FILE_CHUNK_BYTES ||
          received + chunk.bytes.byteLength > session.totalLength ||
          (!chunk.eof && chunk.bytes.byteLength === 0)
        ) {
          return { status: "failed", code: "malformed" };
        }
        chunks.push(chunk.bytes);
        received += chunk.bytes.byteLength;
        if (chunk.eof) {
          sessionOpen = false;
          if (received !== session.totalLength) return { status: "failed", code: "raced" };
        }
      }
      const bytes = joinBytes(chunks, received);
      if (createHash("sha256").update(bytes).digest("hex") !== session.metadata.digest) {
        return { status: "failed", code: "raced" };
      }
      return { status: "available", metadata: session.metadata, bytes };
    } finally {
      if (sessionOpen) {
        await this.#execute({
          ...location,
          operation: "cancelSession",
          sessionId: session.sessionId,
        });
      }
    }
  }

  async #execute(
    request: CodeFileOperationRequest,
    signal?: AbortSignal,
  ): Promise<ParsedPortResult<unknown>> {
    if (signal?.aborted) return { status: "failed", code: "interrupted" };
    let response: FileOperationResponse;
    try {
      response = await this.#port.execute(request, signal);
    } catch {
      return { status: "failed", code: "interrupted" };
    }
    return response.ok
      ? { status: "available", value: response.result }
      : { status: "failed", code: response.failure.code };
  }
}

function prepareLocation(
  input: CodeFileLocation,
):
  | Readonly<{ location: PreparedLocation }>
  | Readonly<{ status: "failed"; failure: CodeFileFailure }> {
  if (
    !validPrivateRoot(input.rootPath) ||
    !validIdentity(input.rootIdentity) ||
    !validRelativePath(input.path)
  ) {
    return invalidFailure("invalid-path");
  }
  return {
    location: {
      rootPath: input.rootPath,
      rootIdentity: input.rootIdentity,
      pathComponents: input.path.split("/"),
    },
  };
}

function validRelativePath(path: string): boolean {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path !== path.normalize("NFC") ||
    encoder.encode(path).byteLength > MAX_CODE_RELATIVE_PATH_BYTES
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        component !== "." &&
        component !== ".." &&
        encoder.encode(component).byteLength <= MAX_CODE_PATH_COMPONENT_BYTES,
    );
}

function validPrivateRoot(path: string): boolean {
  return typeof path === "string" && path.startsWith("/") && !path.includes("\0");
}

function validIdentity(value: FileIdentity): boolean {
  return (
    typeof value === "object" && value !== null && nonEmpty(value.device) && nonEmpty(value.inode)
  );
}

function validDigest(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSearchQuery(query: string): boolean {
  return (
    typeof query === "string" &&
    query.length > 0 &&
    !query.includes("\0") &&
    encodeValidUtf8(query) !== undefined &&
    encoder.encode(query).byteLength <= MAX_SEARCH_QUERY_BYTES
  );
}

function encodeValidUtf8(value: string): Uint8Array | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = encoder.encode(value);
  return decodeUtf8(bytes) === value ? bytes : undefined;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = fatalDecoder.decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

function normalizeMatches(
  path: string,
  text: string,
  query: string,
): Readonly<{ bytes: Uint8Array; matchCount: number; truncated: boolean }> {
  const records: Uint8Array[] = [];
  let byteLength = 0;
  let matchCount = 0;
  let truncated = false;
  const lines = text.split("\n");

  outer: for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    let from = 0;
    while (from <= line.length) {
      const column = line.indexOf(query, from);
      if (column < 0) break;
      if (matchCount >= MAX_SEARCH_MATCHES) {
        truncated = true;
        break outer;
      }
      const record = encoder.encode(
        `${JSON.stringify({
          path,
          line: lineIndex + 1,
          column: column + 1,
          preview: line.slice(0, 512).normalize("NFC"),
        })}\n`,
      );
      if (byteLength + record.byteLength > MAX_SEARCH_RESULT_BYTES) {
        truncated = true;
        break outer;
      }
      records.push(record);
      byteLength += record.byteLength;
      matchCount += 1;
      from = column + query.length;
    }
  }
  return { bytes: joinBytes(records, byteLength), matchCount, truncated };
}

function parseMetadataEnvelope(value: unknown): CodeFileMetadata | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ["metadata"])) return undefined;
  return parseMetadata(value.metadata);
}

function parseMetadata(value: unknown): CodeFileMetadata | undefined {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["identity", "byteLength", "modifiedNanoseconds", "digest"]) ||
    !validParsedIdentity(value.identity) ||
    !nonNegativeSafeInteger(value.byteLength) ||
    !nonEmpty(value.modifiedNanoseconds) ||
    !validDigestValue(value.digest)
  ) {
    return undefined;
  }
  return {
    identity: value.identity,
    byteLength: value.byteLength,
    modifiedNanoseconds: value.modifiedNanoseconds,
    digest: value.digest,
  };
}

function parseReadSession(
  value: unknown,
): Readonly<{ sessionId: string; totalLength: number; metadata: CodeFileMetadata }> | undefined {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["sessionId", "totalLength", "metadata"]) ||
    !nonEmpty(value.sessionId) ||
    !nonNegativeSafeInteger(value.totalLength)
  ) {
    return undefined;
  }
  const metadata = parseMetadata(value.metadata);
  if (metadata === undefined || metadata.byteLength !== value.totalLength) return undefined;
  return { sessionId: value.sessionId, totalLength: value.totalLength, metadata };
}

function parseReadChunk(
  value: unknown,
): Readonly<{ offset: number; bytes: Uint8Array; eof: boolean }> | undefined {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["offset", "dataBase64", "eof"]) ||
    !nonNegativeSafeInteger(value.offset) ||
    typeof value.dataBase64 !== "string" ||
    typeof value.eof !== "boolean" ||
    !validBase64(value.dataBase64)
  ) {
    return undefined;
  }
  return {
    offset: value.offset,
    bytes: Uint8Array.from(Buffer.from(value.dataBase64, "base64")),
    eof: value.eof,
  };
}

function parseIdentifierResult(value: unknown, key: string): string | undefined {
  return isRecord(value) && hasExactlyKeys(value, [key]) && nonEmpty(value[key])
    ? value[key]
    : undefined;
}

function parseAcceptedLength(value: unknown): number | undefined {
  return isRecord(value) &&
    hasExactlyKeys(value, ["acceptedLength"]) &&
    nonNegativeSafeInteger(value.acceptedLength)
    ? value.acceptedLength
    : undefined;
}

function parseCommitResult(
  value: unknown,
): Readonly<{ byteLength: number; digest: string }> | undefined {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["byteLength", "digest"]) ||
    !nonNegativeSafeInteger(value.byteLength) ||
    !validDigestValue(value.digest)
  ) {
    return undefined;
  }
  return { byteLength: value.byteLength, digest: value.digest };
}

function joinBytes(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function validParsedIdentity(value: unknown): value is FileIdentity {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["device", "inode"]) &&
    nonEmpty(value.device) &&
    nonEmpty(value.inode)
  );
}

function validDigestValue(value: unknown): value is string {
  return typeof value === "string" && validDigest(value);
}

function validBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidFailure(code: string): Readonly<{ status: "failed"; failure: CodeFileFailure }> {
  return { status: "failed", failure: { category: "invalid", code } };
}

function contentFailure(error: unknown): Readonly<{ status: "failed"; failure: CodeFileFailure }> {
  return {
    status: "failed",
    failure: {
      category: error instanceof CodeContentStoreError ? "unavailable" : "failed",
      code: error instanceof CodeContentStoreError ? `content-${error.code}` : "content-failed",
    },
  };
}

function readFailure(
  code: string,
):
  | Readonly<{ status: "interrupted"; rescanRequired: true }>
  | Readonly<{ status: "failed"; failure: CodeFileFailure }> {
  if (code === "interrupted" || code === "conflict") return interrupted();
  return { status: "failed", failure: { category: "failed", code } };
}

function mutationFailure(code: string): CodeFileSaveResult {
  if (code === "interrupted") return interrupted();
  if (code === "identity-mismatch" || code === "digest-mismatch" || code === "conflict") {
    return { status: "conflict", failure: { category: "conflict", code } };
  }
  return { status: "failed", failure: { category: "failed", code } };
}

function interrupted(): Readonly<{ status: "interrupted"; rescanRequired: true }> {
  return { status: "interrupted", rescanRequired: true };
}
