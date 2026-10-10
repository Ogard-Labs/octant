/**
 * Labelled API keys for one provider instance.
 *
 * The host credential store holds one opaque string per instance. A pool is
 * that string as JSON: keys in list order, each with a label the person
 * chose, and the id of the active key. A plain string is a pool of one key
 * labelled "Default", so instances stored before pools existed keep working
 * without a migration.
 *
 * A request sends the active key first. A key a provider refused for a quota
 * or a limit cools down, and the request then uses the next key that is not
 * cooling, in list order. Cooling is held in host memory, so a restart tries
 * the active key again.
 */

const KIND = "api-key-pool";
const VERSION = 1;
const LEGACY_KEY_ID = "default";
const LEGACY_LABEL = "Default";
const KEY_ID_PATTERN = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const MAX_API_KEYS_PER_PROVIDER = 16;
export const MAX_API_KEY_LABEL_LENGTH = 64;
export const MAX_API_KEY_SECRET_LENGTH = 1024;
/** Keeps the stored pool under the host broker's 12 KiB credential limit. */
const MAX_POOL_BYTES = 11 * 1024;

export const RATE_LIMIT_COOLDOWN_MS = 60_000;
export const QUOTA_COOLDOWN_MS = 60 * 60_000;
const MAX_RETRY_AFTER_COOLDOWN_MS = 10 * 60_000;

/**
 * Words a provider uses when a key has run out of money or a spend cap has
 * been reached. Anthropic and OpenAI put these in the body of a 400, 403, or
 * 429, so the status alone does not say whether the limit lifts on its own.
 */
const QUOTA_EXHAUSTED_TEXT =
  /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|billing|spend[ _]limit|usage limits? (?:has been )?reached|reached your specified|out of credits/i;

export interface ApiKeyEntry {
  readonly id: string;
  readonly label: string;
  readonly secret: string;
}

/** What the desktop may show about a key. The secret never leaves the host. */
export interface ApiKeySummary {
  readonly id: string;
  readonly label: string;
  /** Exactly one key of a pool is active: a request sends it first. */
  readonly active: boolean;
}

export type ApiKeyMoveDirection = "up" | "down";

export type ApiKeyPoolErrorReason =
  | "corrupt"
  | "empty"
  | "invalid-label"
  | "invalid-secret"
  | "duplicate-label"
  | "too-many-keys"
  | "too-large"
  | "unknown-key";

const POOL_ERROR_MESSAGES: Readonly<Record<ApiKeyPoolErrorReason, string>> = {
  corrupt: "The stored API keys could not be read.",
  empty: "At least one API key is required.",
  "invalid-label": "A key label must be 1 to 64 characters with no control characters.",
  "invalid-secret": "An API key must be 1 to 1024 characters with no spaces.",
  "duplicate-label": "Two keys for this provider cannot have the same label.",
  "too-many-keys": "A provider can hold at most 16 API keys.",
  "too-large": "The API keys for this provider are too large to store.",
  "unknown-key": "That API key is no longer stored.",
};

export class ApiKeyPoolError extends Error {
  readonly reason: ApiKeyPoolErrorReason;

  constructor(reason: ApiKeyPoolErrorReason) {
    super(POOL_ERROR_MESSAGES[reason]);
    this.name = "ApiKeyPoolError";
    this.reason = reason;
  }
}

/** The keys a stored value holds, in list order. Empty when nothing is stored. */
export function readApiKeyPool(stored: string): readonly ApiKeyEntry[] {
  return readPool(stored).entries;
}

/**
 * The keys in the order a request tries them: the active key first, then the
 * others in list order. The request path reads this order; the editor shows
 * the list order.
 */
export function apiKeysInUseOrder(stored: string): readonly ApiKeyEntry[] {
  const state = readPool(stored);
  const active = activeIdOf(state);
  return [
    ...state.entries.filter((entry) => entry.id === active),
    ...state.entries.filter((entry) => entry.id !== active),
  ];
}

export function listApiKeys(stored: string): readonly ApiKeySummary[] {
  const state = readEditablePool(stored);
  const active = activeIdOf(state);
  return state.entries.map(({ id, label }) => ({ id, label, active: id === active }));
}

/**
 * Appends a key to the end of the list. A label is "Key N" unless the person
 * chose one. The first key of a pool becomes active; later keys do not change
 * which key is active.
 */
export function addApiKey(
  stored: string | undefined,
  input: { readonly secret: string; readonly label?: string | undefined },
): { readonly stored: string; readonly key: ApiKeySummary } {
  const state = stored === undefined ? NO_KEYS : readEditablePool(stored);
  const entries = [...state.entries];
  const label = input.label === undefined ? nextDefaultLabel(entries) : input.label.trim();
  const key: ApiKeyEntry = {
    id: globalThis.crypto.randomUUID(),
    label,
    secret: input.secret.trim(),
  };
  const activeId = state.entries.length === 0 ? key.id : activeIdOf(state);
  const next = writePool([...entries, key], activeId);
  return { stored: next, key: { id: key.id, label: key.label, active: activeId === key.id } };
}

export function renameApiKey(stored: string, keyId: string, label: string): string {
  const state = readEditablePool(stored);
  const entries = state.entries.map((entry) =>
    entry.id === keyId ? { ...entry, label: label.trim() } : entry,
  );
  requireKnownKey(entries, keyId);
  return writePool(entries, activeIdOf(state));
}

export function replaceApiKeySecret(stored: string, keyId: string, secret: string): string {
  const state = readEditablePool(stored);
  const entries = state.entries.map((entry) =>
    entry.id === keyId ? { ...entry, secret: secret.trim() } : entry,
  );
  requireKnownKey(entries, keyId);
  return writePool(entries, activeIdOf(state));
}

/**
 * Makes one key the active key, which a request sends first. The list order
 * does not change.
 */
export function setActiveApiKey(stored: string, keyId: string): string {
  const state = readEditablePool(stored);
  requireKnownKey(state.entries, keyId);
  return writePool(state.entries, keyId);
}

/**
 * Swaps one key with its neighbour in the list. Moving the first key up, or
 * the last key down, changes nothing. The active key stays active.
 */
export function moveApiKey(stored: string, keyId: string, direction: ApiKeyMoveDirection): string {
  const state = readEditablePool(stored);
  const entries = [...state.entries];
  const index = entries.findIndex((entry) => entry.id === keyId);
  if (index === -1) throw new ApiKeyPoolError("unknown-key");
  const target = direction === "up" ? index - 1 : index + 1;
  const moved = entries[index];
  const neighbour = entries[target];
  if (moved !== undefined && neighbour !== undefined) {
    entries[index] = neighbour;
    entries[target] = moved;
  }
  return writePool(entries, activeIdOf(state));
}

/**
 * Removes one key. When the active key is removed, the first key left becomes
 * active. Returns `undefined` when no key is left, so the caller deletes the entry.
 */
export function removeApiKey(stored: string, keyId: string): string | undefined {
  const state = readEditablePool(stored);
  requireKnownKey(state.entries, keyId);
  const remaining = state.entries.filter((entry) => entry.id !== keyId);
  if (remaining.length === 0) return undefined;
  const active = activeIdOf(state);
  return writePool(remaining, active === keyId ? remaining[0]?.id : active);
}

/**
 * The key a request should use: the first one not cooling down, in the order
 * from `apiKeysInUseOrder`. When every key is cooling, the one that recovers
 * first, because it is the likeliest to work and a stale cooldown must not
 * lock the instance out.
 */
export function selectApiKey(
  entries: readonly ApiKeyEntry[],
  cooldownUntil: ReadonlyMap<string, number>,
  nowMs: number,
): ApiKeyEntry | undefined {
  const ready = entries.find((entry) => (cooldownUntil.get(entry.id) ?? 0) <= nowMs);
  if (ready !== undefined) return ready;
  return entries.reduce<ApiKeyEntry | undefined>(
    (soonest, entry) =>
      soonest === undefined ||
      (cooldownUntil.get(entry.id) ?? 0) < (cooldownUntil.get(soonest.id) ?? 0)
        ? entry
        : soonest,
    undefined,
  );
}

export interface KeyRejection {
  readonly status: number;
  readonly body: string;
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * How long a refused key should sit out, or `undefined` when the refusal is
 * not about quota or a limit. A bad key (401, 403 without quota words) and a
 * malformed request are not switched: another key would fail the same way,
 * and a bad key should be fixed, not hidden.
 */
export function keyCooldownMs(rejection: KeyRejection): number | undefined {
  if (rejection.status === 402) return QUOTA_COOLDOWN_MS;
  if (rejection.status !== 400 && rejection.status !== 403 && rejection.status !== 429) {
    return undefined;
  }
  if (QUOTA_EXHAUSTED_TEXT.test(rejection.body)) return QUOTA_COOLDOWN_MS;
  if (rejection.status !== 429) return undefined;
  if (rejection.retryAfterSeconds === undefined) return RATE_LIMIT_COOLDOWN_MS;
  return Math.min(rejection.retryAfterSeconds * 1000, MAX_RETRY_AFTER_COOLDOWN_MS);
}

/** A `Retry-After` header in seconds. HTTP dates are not read, so they count as absent. */
export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

interface PoolState {
  readonly entries: readonly ApiKeyEntry[];
  /** The stored active id. It may not name a key any more; `activeIdOf` resolves that. */
  readonly active: string | undefined;
}

const NO_KEYS: PoolState = { entries: [], active: undefined };

function readPool(stored: string): PoolState {
  if (stored.length === 0) return NO_KEYS;
  const pool = parsePool(stored);
  if (pool !== undefined) return pool;
  return {
    entries: [{ id: LEGACY_KEY_ID, label: LEGACY_LABEL, secret: stored }],
    active: LEGACY_KEY_ID,
  };
}

/**
 * The keys the Settings editor works on. A sign-in grant stored in the same
 * slot is not a key, so it holds none: adding a key then replaces the grant,
 * which is what saving a key has always done. The provider's own request path
 * still reads the grant through `readApiKeyPool`.
 */
function readEditablePool(stored: string): PoolState {
  if (isOtherStoredKind(stored)) return NO_KEYS;
  return readPool(stored);
}

/** The active key, falling back to the first key when the stored id names none. */
function activeIdOf(state: PoolState): string | undefined {
  if (state.entries.some((entry) => entry.id === state.active)) return state.active;
  return state.entries[0]?.id;
}

/** A JSON value of some other kind, such as a sign-in grant, rather than a key. */
function isOtherStoredKind(stored: string): boolean {
  if (!stored.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isRecord(parsed) && typeof parsed.kind === "string" && parsed.kind !== KIND;
  } catch {
    return false;
  }
}

function parsePool(stored: string): PoolState | undefined {
  if (!stored.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.kind !== KIND) return undefined;
  if (parsed.version !== VERSION || !Array.isArray(parsed.keys)) {
    throw new ApiKeyPoolError("corrupt");
  }
  const entries = parsed.keys.map((key: unknown): ApiKeyEntry => {
    if (
      !isRecord(key) ||
      typeof key.id !== "string" ||
      !KEY_ID_PATTERN.test(key.id) ||
      typeof key.label !== "string" ||
      typeof key.secret !== "string"
    ) {
      throw new ApiKeyPoolError("corrupt");
    }
    return { id: key.id, label: key.label, secret: key.secret };
  });
  assertPool(entries);
  return { entries, active: typeof parsed.active === "string" ? parsed.active : undefined };
}

function writePool(entries: readonly ApiKeyEntry[], activeId: string | undefined): string {
  assertPool(entries);
  const active = entries.some((entry) => entry.id === activeId) ? activeId : entries[0]?.id;
  const encoded = JSON.stringify({
    kind: KIND,
    version: VERSION,
    active,
    keys: entries.map(({ id, label, secret }) => ({ id, label, secret })),
  });
  if (new TextEncoder().encode(encoded).byteLength > MAX_POOL_BYTES) {
    throw new ApiKeyPoolError("too-large");
  }
  return encoded;
}

function assertPool(entries: readonly ApiKeyEntry[]): void {
  if (entries.length === 0) throw new ApiKeyPoolError("empty");
  if (entries.length > MAX_API_KEYS_PER_PROVIDER) throw new ApiKeyPoolError("too-many-keys");
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const entry of entries) {
    if (!KEY_ID_PATTERN.test(entry.id) || ids.has(entry.id)) throw new ApiKeyPoolError("corrupt");
    ids.add(entry.id);
    if (!isValidLabel(entry.label)) throw new ApiKeyPoolError("invalid-label");
    if (!isValidSecret(entry.secret)) throw new ApiKeyPoolError("invalid-secret");
    const folded = entry.label.toLowerCase();
    if (labels.has(folded)) throw new ApiKeyPoolError("duplicate-label");
    labels.add(folded);
  }
}

function isValidLabel(label: string): boolean {
  if (label.length === 0 || label.length > MAX_API_KEY_LABEL_LENGTH) return false;
  for (const character of label) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return label === label.trim();
}

function isValidSecret(secret: string): boolean {
  return secret.length > 0 && secret.length <= MAX_API_KEY_SECRET_LENGTH && !/\s/.test(secret);
}

function nextDefaultLabel(entries: readonly ApiKeyEntry[]): string {
  const taken = new Set(entries.map((entry) => entry.label.toLowerCase()));
  for (let number = entries.length + 1; ; number += 1) {
    const label = `Key ${number}`;
    if (!taken.has(label.toLowerCase())) return label;
  }
}

function requireKnownKey(entries: readonly ApiKeyEntry[], keyId: string): void {
  if (!entries.some((entry) => entry.id === keyId)) throw new ApiKeyPoolError("unknown-key");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
