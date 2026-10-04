import {
  decodeThreadMessageQueueCommand,
  MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueScope,
} from "@octant/contracts";

const PREFIX = "octant.composer.queue-receipt.v1:";
export type QueueReceiptStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
export interface QueueReceipt {
  readonly host: string;
  readonly command: ThreadMessageQueueCommand;
  readonly draftDigest?: string;
  readonly draftChanged?: boolean;
  readonly accepted?: boolean;
  readonly refused?: boolean;
}
export type QueueReceiptRead =
  | { readonly status: "ready"; readonly receipts: ReadonlyArray<QueueReceipt> }
  | { readonly status: "unavailable" };

export function queueReceiptStorage(): QueueReceiptStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
function key(receipt: QueueReceipt): string {
  const { mode, threadId } = receipt.command.scope;
  return `${PREFIX}${encodeURIComponent(receipt.host)}:${mode}:${threadId}:${receipt.command.requestId}`;
}
function keys(storage: QueueReceiptStorage): ReadonlyArray<string> {
  const found: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const candidate = storage.key(i);
    if (candidate?.startsWith(PREFIX)) found.push(candidate);
  }
  return found;
}
function decode(raw: string): QueueReceipt {
  if (new TextEncoder().encode(raw).byteLength > MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES + 1024)
    throw new Error("Queue receipt exceeds its private storage bound.");
  const value: unknown = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    !("host" in value) ||
    typeof value.host !== "string" ||
    !("command" in value)
  )
    throw new Error("Invalid queue receipt.");
  const command = decodeThreadMessageQueueCommand(value.command);
  const draftDigest = "draftDigest" in value ? value.draftDigest : undefined;
  if (
    draftDigest !== undefined &&
    (typeof draftDigest !== "string" || !/^[a-f0-9]{64}$/.test(draftDigest))
  )
    throw new Error("Invalid queue draft identity.");
  return {
    host: value.host,
    command,
    ...(draftDigest === undefined ? {} : { draftDigest }),
    ...("draftChanged" in value && value.draftChanged === true ? { draftChanged: true } : {}),
    ...("accepted" in value && value.accepted === true ? { accepted: true } : {}),
    ...("refused" in value && value.refused === true ? { refused: true } : {}),
  };
}
export function readQueueReceipts(
  host: string,
  scope: ThreadMessageQueueScope,
  storage = queueReceiptStorage(),
): QueueReceiptRead {
  if (storage === undefined) return { status: "unavailable" };
  const prefix = `${PREFIX}${encodeURIComponent(host)}:${scope.mode}:${scope.threadId}:`;
  try {
    const receipts: QueueReceipt[] = [];
    for (const candidate of keys(storage)) {
      if (!candidate.startsWith(prefix)) continue;
      const raw = storage.getItem(candidate);
      if (raw === null) continue;
      const receipt = decode(raw);
      if (key(receipt) !== candidate) return { status: "unavailable" };
      receipts.push(receipt);
    }
    return { status: "ready", receipts };
  } catch {
    return { status: "unavailable" };
  }
}
export function saveQueueReceipt(receipt: QueueReceipt, storage = queueReceiptStorage()): boolean {
  if (storage === undefined) return false;
  try {
    const encoded = JSON.stringify(receipt);
    decode(encoded);
    storage.setItem(key(receipt), encoded);
    return storage.getItem(key(receipt)) === encoded;
  } catch {
    return false;
  }
}
export function removeQueueReceipt(
  receipt: QueueReceipt,
  storage = queueReceiptStorage(),
): boolean {
  if (storage === undefined) return false;
  try {
    storage.removeItem(key(receipt));
    return storage.getItem(key(receipt)) === null;
  } catch {
    return false;
  }
}
export async function queueDraftDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Draft edits invalidate the old draft identity even if the person later types
// identical text. Keep that fact with the receipt across renderer restarts.
export function markQueueDraftChanged(
  mode: string,
  threadId: string | undefined,
  storage: QueueReceiptStorage | undefined,
): boolean {
  if (storage === undefined || threadId === undefined) return true;
  try {
    for (const candidate of keys(storage)) {
      if (!candidate.includes(`:${mode}:${threadId}:`)) continue;
      const raw = storage.getItem(candidate);
      if (raw === null) continue;
      const receipt = decode(raw);
      if (!saveQueueReceipt({ ...receipt, draftChanged: true }, storage)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export function purgeQueueReceipts(
  keep: (scope: { readonly mode: string; readonly threadId: string }) => boolean,
  storage: QueueReceiptStorage | undefined,
): boolean {
  if (storage === undefined) return true;
  try {
    for (const candidate of keys(storage)) {
      // Parse identity from the key so even an unreadable payload is purgeable.
      const parts = candidate.slice(PREFIX.length).split(":");
      const mode = parts[1];
      const threadId = parts[2];
      if (mode !== undefined && threadId !== undefined && keep({ mode, threadId })) continue;
      storage.removeItem(candidate);
      if (storage.getItem(candidate) !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export function asQueueReceiptStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined,
): QueueReceiptStorage | undefined {
  return storage !== undefined &&
    "key" in storage &&
    typeof storage.key === "function" &&
    "length" in storage &&
    typeof storage.length === "number"
    ? {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
        removeItem: (key) => storage.removeItem(key),
        key: (index) => {
          const method = storage.key;
          if (typeof method !== "function") return null;
          const result: unknown = method.call(storage, index);
          return typeof result === "string" ? result : null;
        },
        get length() {
          return typeof storage.length === "number" ? storage.length : 0;
        },
      }
    : undefined;
}
