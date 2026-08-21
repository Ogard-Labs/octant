import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAgentRunWorkspaceReceiptId,
  type AgentRunWorkspaceReceiptId,
  type OctantMode,
} from "@octant/contracts";
import type { AgentRunIssuedWorkspaceGrant } from "@octant/domain/agent-run-workspace-policy";

export const AGENT_RUN_WORKSPACE_RECEIPT_TTL_MS = 5 * 60_000;
const RECEIPTS_DIRECTORY = "agent-run-workspace-receipts";
const RECEIPT_VERSION = 1;

export interface StoredAgentRunWorkspaceReceipt extends AgentRunIssuedWorkspaceGrant {
  readonly windowId: string;
  readonly issuedAt: string;
}

export interface AgentRunWorkspaceReceiptStoreOptions {
  readonly dataDirectory: string;
  readonly clock?: () => string;
  readonly uuid?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is OctantMode {
  return value === "chat" || value === "work" || value === "code";
}

function decodeStored(value: unknown): StoredAgentRunWorkspaceReceipt | undefined {
  if (!isRecord(value) || value.version !== RECEIPT_VERSION) return undefined;
  if (typeof value.receiptId !== "string" || typeof value.parentThreadId !== "string") {
    return undefined;
  }
  if (typeof value.windowId !== "string" || !isMode(value.mode)) return undefined;
  if (typeof value.confirmed !== "boolean" || typeof value.expiresAt !== "number") return undefined;
  if (typeof value.issuedAt !== "string") return undefined;
  const optionalString = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] : undefined;
  const projectId = optionalString("projectId");
  const bindingRevisionId = optionalString("bindingRevisionId");
  const canonicalRoot = optionalString("canonicalRoot");
  const worktreeReceiptId = optionalString("worktreeReceiptId");
  const checkoutRoot = optionalString("checkoutRoot");
  const worktreeRoot = optionalString("worktreeRoot");
  const worktreeState = optionalString("worktreeState");
  return {
    receiptId: value.receiptId,
    parentThreadId: value.parentThreadId,
    windowId: value.windowId,
    mode: value.mode,
    confirmed: value.confirmed,
    expiresAt: value.expiresAt,
    issuedAt: value.issuedAt,
    ...(projectId === undefined ? {} : { projectId }),
    ...(bindingRevisionId === undefined ? {} : { bindingRevisionId }),
    ...(canonicalRoot === undefined ? {} : { canonicalRoot }),
    ...(worktreeReceiptId === undefined ? {} : { worktreeReceiptId }),
    ...(checkoutRoot === undefined ? {} : { checkoutRoot }),
    ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    ...(worktreeState === undefined ? {} : { worktreeState }),
  };
}

/**
 * Durable, host-local store for prepared child workspace grants.
 *
 * Receipts survive process restart so a prepare issued before a crash can still
 * be confirmed or admitted, and expired grants are dropped lazily. Absolute
 * roots stay in this store; the renderer never reads the files.
 */
export class AgentRunWorkspaceReceiptStore {
  readonly #root: string;
  readonly #clock: () => string;
  readonly #uuid: () => string;

  constructor(options: AgentRunWorkspaceReceiptStoreOptions) {
    this.#root = join(options.dataDirectory, RECEIPTS_DIRECTORY);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  async issue(
    input: Omit<StoredAgentRunWorkspaceReceipt, "receiptId" | "issuedAt" | "expiresAt"> & {
      readonly now: number;
      readonly receiptId?: string;
    },
  ): Promise<StoredAgentRunWorkspaceReceipt> {
    const receiptId = input.receiptId ?? this.#uuid();
    const stored: StoredAgentRunWorkspaceReceipt = {
      receiptId,
      parentThreadId: input.parentThreadId,
      windowId: input.windowId,
      mode: input.mode,
      confirmed: input.confirmed,
      expiresAt: input.now + AGENT_RUN_WORKSPACE_RECEIPT_TTL_MS,
      issuedAt: this.#clock(),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.bindingRevisionId === undefined
        ? {}
        : { bindingRevisionId: input.bindingRevisionId }),
      ...(input.canonicalRoot === undefined ? {} : { canonicalRoot: input.canonicalRoot }),
      ...(input.worktreeReceiptId === undefined
        ? {}
        : { worktreeReceiptId: input.worktreeReceiptId }),
      ...(input.checkoutRoot === undefined ? {} : { checkoutRoot: input.checkoutRoot }),
      ...(input.worktreeRoot === undefined ? {} : { worktreeRoot: input.worktreeRoot }),
      ...(input.worktreeState === undefined ? {} : { worktreeState: input.worktreeState }),
    };
    await this.#write(stored);
    return stored;
  }

  async load(receiptId: string): Promise<StoredAgentRunWorkspaceReceipt | undefined> {
    let parsedId: AgentRunWorkspaceReceiptId;
    try {
      parsedId = decodeAgentRunWorkspaceReceiptId(receiptId);
    } catch {
      return undefined;
    }
    let contents: string;
    try {
      contents = await readFile(this.#path(String(parsedId)), "utf8");
    } catch {
      return undefined;
    }
    try {
      return decodeStored(JSON.parse(contents) as unknown);
    } catch {
      return undefined;
    }
  }

  async findReusable(input: {
    readonly parentThreadId: string;
    readonly mode: OctantMode;
    readonly windowId: string;
    readonly now: number;
  }): Promise<StoredAgentRunWorkspaceReceipt | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const receipt = await this.load(entry.replace(/\.json$/, ""));
      if (receipt === undefined || input.now >= receipt.expiresAt) continue;
      if (
        receipt.parentThreadId !== input.parentThreadId ||
        receipt.mode !== input.mode ||
        receipt.windowId !== input.windowId
      ) {
        continue;
      }
      return receipt;
    }
    return undefined;
  }

  async save(receipt: StoredAgentRunWorkspaceReceipt): Promise<StoredAgentRunWorkspaceReceipt> {
    await this.#write(receipt);
    return receipt;
  }

  #path(receiptId: string): string {
    return join(this.#root, `${receiptId}.json`);
  }

  async #write(receipt: StoredAgentRunWorkspaceReceipt): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ version: RECEIPT_VERSION, ...receipt });
    await writeFile(this.#path(receipt.receiptId), payload, { encoding: "utf8", mode: 0o600 });
  }

  async forgetExpired(now: number): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const receipt = await this.load(entry.replace(/\.json$/, ""));
      if (receipt === undefined || now >= receipt.expiresAt) {
        await unlink(join(this.#root, entry)).catch(() => undefined);
      }
    }
  }
}
