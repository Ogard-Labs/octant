import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAppleActionKind,
  decodeAppleSimulatorId,
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeToolActionAuthority,
  decodeToolActionId,
} from "@octant/contracts";
import { Schema } from "effect";
import { CorrelationId, UtcTimestamp } from "@octant/contracts";
import type { AppleRuntimeReceipt } from "./appleToolchainService";

const MAX_RECEIPTS = 64;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SAFE_REFERENCE = /^apple-[a-z0-9-]{1,500}$/;
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export class AppleRuntimeStore {
  readonly #root: string;
  readonly #artifactRoot: string;
  readonly #receiptPath: string;

  constructor(root: string) {
    this.#root = root;
    this.#artifactRoot = join(root, "artifacts");
    this.#receiptPath = join(root, "active-actions.json");
  }

  get artifactRoot(): string {
    return this.#artifactRoot;
  }

  async writeArtifact(reference: string, bytes: Uint8Array): Promise<void> {
    if (!SAFE_REFERENCE.test(reference) || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("Apple artifact is invalid.");
    }
    await mkdir(this.#artifactRoot, { recursive: true, mode: 0o700 });
    const target = join(this.#artifactRoot, reference);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
  }

  async readArtifact(reference: string): Promise<Uint8Array | undefined> {
    if (!SAFE_REFERENCE.test(reference)) return undefined;
    try {
      const bytes = await readFile(join(this.#artifactRoot, reference));
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) return undefined;
      return new Uint8Array(bytes);
    } catch {
      return undefined;
    }
  }

  async persistReceipts(receipts: ReadonlyArray<AppleRuntimeReceipt>): Promise<void> {
    if (receipts.length > MAX_RECEIPTS) throw new Error("Too many Apple runtime receipts.");
    const validated = receipts.map(validateReceipt);
    const payload = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_RECEIPT_BYTES) {
      throw new Error("Apple runtime receipt state is too large.");
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporary = `${this.#receiptPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#receiptPath);
  }

  async loadReceipts(): Promise<ReadonlyArray<AppleRuntimeReceipt>> {
    try {
      const payload = await readFile(this.#receiptPath);
      if (payload.byteLength > MAX_RECEIPT_BYTES) return [];
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
      if (!Array.isArray(parsed) || parsed.length > MAX_RECEIPTS) return [];
      return parsed.map(validateReceipt);
    } catch {
      return [];
    }
  }
}

function validateReceipt(value: unknown): AppleRuntimeReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Apple runtime receipt is invalid.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "actionId",
    "correlationId",
    "authority",
    "threadId",
    "checkoutId",
    "kind",
    "simulatorId",
    "bundleIdentifier",
    "startedAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("Apple runtime receipt is invalid.");
  }
  const kind = decodeAppleActionKind(input.kind);
  const simulatorId =
    input.simulatorId === undefined ? undefined : decodeAppleSimulatorId(input.simulatorId);
  const bundleIdentifier =
    typeof input.bundleIdentifier === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(input.bundleIdentifier)
      ? input.bundleIdentifier
      : undefined;
  if (input.bundleIdentifier !== undefined && bundleIdentifier === undefined) {
    throw new Error("Apple runtime receipt is invalid.");
  }
  return {
    actionId: decodeToolActionId(input.actionId),
    correlationId: decodeCorrelationId(input.correlationId),
    authority: decodeToolActionAuthority(input.authority),
    threadId: decodeCodeThreadId(input.threadId),
    checkoutId: decodeCodeCheckoutId(input.checkoutId),
    kind,
    ...(simulatorId === undefined ? {} : { simulatorId }),
    ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }),
    startedAt: decodeTimestamp(input.startedAt),
  };
}
