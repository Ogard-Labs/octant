/**
 * Which paired computers this phone registered notifications with, and the
 * platform token each registration was made under. It lets the phone notice
 * that the system issued a new token (Apple and Google both rotate them,
 * and a restored or reinstalled app gets a different one) and register the
 * new one with every computer that expects notifications.
 *
 * The record holds a digest of the token, never the token, the capability, or
 * a key. It lives in secure storage beside the host list.
 */
export interface PushRegistrationRecord {
  readonly hostId: string;
  /** The device id the computer knows this phone by; the notification key binds it. */
  readonly deviceId: string;
  /** The fingerprint the phone saw at pairing, which a new capability is bound to. */
  readonly hostKeyFingerprint: string;
  /** SHA-256 of the platform token the computer's registration was made under, in hex. */
  readonly tokenDigest: string;
  /**
   * Set when the phone was told to forget this computer but could not delete
   * its notification key. The record is kept so the next run tries the
   * deletion again, and is never rotated, so the key is not used again.
   */
  readonly forgetPending?: true;
}

/**
 * Keeps an older operation from undoing a newer one on the same computer. Turning
 * notifications off cancels whatever was started before it and waits for it to
 * stop, so a rotation that began earlier cannot re-register, recreate the key,
 * or restore the record once the person has turned them off.
 */
export interface PhoneNotificationLifecycle {
  /** Ends every operation on this computer started before now, at its next checkpoint. */
  readonly cancel: (hostId: string) => void;
  /**
   * Runs one operation on a computer after those started before it. Waits at
   * most `maxWaitMs` for them (an operation stuck on the network must not hold
   * up removing a computer); the operation sees `isCancelled` turn true once
   * `cancel` is called for the computer after this call.
   */
  readonly run: <T>(
    hostId: string,
    operation: (isCancelled: () => boolean) => Promise<T>,
    maxWaitMs?: number,
  ) => Promise<T>;
}

export function createPhoneNotificationLifecycle(): PhoneNotificationLifecycle {
  const generations = new Map<string, number>();
  const tails = new Map<string, Promise<unknown>>();
  const generationOf = (hostId: string) => generations.get(hostId) ?? 0;
  return {
    cancel(hostId) {
      generations.set(hostId, generationOf(hostId) + 1);
    },
    run(hostId, operation, maxWaitMs) {
      const started = generationOf(hostId);
      const before = tails.get(hostId) ?? Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited =
        maxWaitMs === undefined
          ? before
          : Promise.race([
              before,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, maxWaitMs);
              }),
            ]).finally(() => clearTimeout(timer));
      const result = waited.then(() => operation(() => generationOf(hostId) !== started));
      tails.set(
        hostId,
        result.catch(() => undefined),
      );
      return result;
    },
  };
}

export interface PushRegistrationBookStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly deleteItem: (key: string) => Promise<void>;
}

export interface PushRegistrationBook {
  /** Shared by every operation on this book, so they can cancel one another. */
  readonly lifecycle: PhoneNotificationLifecycle;
  readonly list: () => Promise<ReadonlyArray<PushRegistrationRecord>>;
  readonly record: (entry: PushRegistrationRecord) => Promise<void>;
  readonly remove: (hostId: string) => Promise<void>;
}

const BOOK_KEY = "octant.mobile.push-registrations.v1";

function isRecord(value: unknown): value is PushRegistrationRecord {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.hostId === "string" &&
    entry.hostId.length > 0 &&
    typeof entry.deviceId === "string" &&
    entry.deviceId.length > 0 &&
    typeof entry.hostKeyFingerprint === "string" &&
    entry.hostKeyFingerprint.length > 0 &&
    typeof entry.tokenDigest === "string" &&
    entry.tokenDigest.length > 0 &&
    (entry.forgetPending === undefined || entry.forgetPending === true)
  );
}

/** SHA-256 of a platform token, in hex. */
export async function digestPlatformToken(
  token: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPushRegistrationBook(
  storage: PushRegistrationBookStorage,
): PushRegistrationBook {
  // A record that cannot be read back exactly is no record: the phone then
  // registers again from the screen rather than rotate on a guess.
  const readAll = async (): Promise<ReadonlyArray<PushRegistrationRecord>> => {
    const raw = await storage.getItem(BOOK_KEY);
    if (raw === null || raw.length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every(isRecord) ? parsed : [];
    } catch {
      return [];
    }
  };
  const writeAll = async (entries: ReadonlyArray<PushRegistrationRecord>): Promise<void> => {
    if (entries.length === 0) {
      await storage.deleteItem(BOOK_KEY);
      return;
    }
    await storage.setItem(BOOK_KEY, JSON.stringify(entries));
  };
  // Each change reads the whole list and writes it back, so two that overlap
  // would drop each other's. They run one after another.
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(change: () => Promise<T>): Promise<T> => {
    const run = writes.then(change);
    writes = run.catch(() => undefined);
    return run;
  };

  return {
    lifecycle: createPhoneNotificationLifecycle(),
    list: () => serialized(readAll),
    record: (entry) =>
      serialized(async () => {
        const others = (await readAll()).filter((existing) => existing.hostId !== entry.hostId);
        await writeAll([...others, entry]);
      }),
    remove: (hostId) =>
      serialized(async () => {
        const entries = await readAll();
        const remaining = entries.filter((existing) => existing.hostId !== hostId);
        if (remaining.length !== entries.length) await writeAll(remaining);
      }),
  };
}
