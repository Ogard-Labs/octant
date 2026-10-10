import { describe, expect, it } from "vitest";
import {
  ApiKeyPoolError,
  QUOTA_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  addApiKey,
  keyCooldownMs,
  listApiKeys,
  parseRetryAfterSeconds,
  readApiKeyPool,
  removeApiKey,
  renameApiKey,
  replaceApiKeySecret,
  selectApiKey,
} from "./apiKeyPool";

const FIRST = "sk-ant-first-0000";
const SECOND = "sk-ant-second-1111";

/** The refusal reason an action throws, or `undefined` when it succeeds. */
function refusalOf(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof ApiKeyPoolError ? error.reason : "unexpected";
  }
}

function poolWithTwoKeys(): { readonly stored: string; readonly ids: readonly string[] } {
  const first = addApiKey(undefined, { secret: FIRST, label: "Work" });
  const second = addApiKey(first.stored, { secret: SECOND, label: "Personal" });
  return { stored: second.stored, ids: [first.key.id, second.key.id] };
}

describe("API key pool", () => {
  it("reads a stored plain key as one key labelled Default", () => {
    expect(listApiKeys(FIRST)).toEqual([{ id: "default", label: "Default" }]);
    expect(readApiKeyPool(FIRST)[0]?.secret).toBe(FIRST);
  });

  it("reads nothing when no key is stored", () => {
    expect(readApiKeyPool("")).toEqual([]);
  });

  it("keeps keys in the order they were added and shows labels without secrets", () => {
    const { stored } = poolWithTwoKeys();
    expect(listApiKeys(stored).map((key) => key.label)).toEqual(["Work", "Personal"]);
    expect(JSON.stringify(listApiKeys(stored))).not.toContain(FIRST);
  });

  it("names an unlabelled key with the next free Key number", () => {
    const first = addApiKey(undefined, { secret: FIRST });
    const second = addApiKey(first.stored, { secret: SECOND });
    expect(first.key.label).toBe("Key 1");
    expect(second.key.label).toBe("Key 2");
  });

  it("keeps a plain key as the first pool entry when a second key is added", () => {
    const added = addApiKey(FIRST, { secret: SECOND, label: "Team" });
    expect(listApiKeys(added.stored)).toEqual([
      { id: "default", label: "Default" },
      { id: added.key.id, label: "Team" },
    ]);
    expect(readApiKeyPool(added.stored).map((key) => key.secret)).toEqual([FIRST, SECOND]);
  });

  it("refuses two keys with the same label, ignoring case", () => {
    const { stored } = poolWithTwoKeys();
    expect(refusalOf(() => addApiKey(stored, { secret: "sk-third", label: "work" }))).toBe(
      "duplicate-label",
    );
  });

  it("refuses an empty, control-character, or whitespace-padded label", () => {
    expect(refusalOf(() => addApiKey(undefined, { secret: FIRST, label: "   " }))).toBe(
      "invalid-label",
    );
    expect(refusalOf(() => addApiKey(undefined, { secret: FIRST, label: "bad\nlabel" }))).toBe(
      "invalid-label",
    );
  });

  it("refuses a secret that contains a space", () => {
    expect(refusalOf(() => addApiKey(undefined, { secret: "sk-one two" }))).toBe("invalid-secret");
  });

  it("refuses more than 16 keys for one provider", () => {
    let stored: string | undefined;
    for (let index = 0; index < 16; index += 1) {
      stored = addApiKey(stored, { secret: `sk-${index}` }).stored;
    }
    expect(refusalOf(() => addApiKey(stored, { secret: "sk-17" }))).toBe("too-many-keys");
  });

  it("renames a key and keeps its secret", () => {
    const { stored, ids } = poolWithTwoKeys();
    const renamed = renameApiKey(stored, ids[1] ?? "", "Client");
    expect(listApiKeys(renamed).map((key) => key.label)).toEqual(["Work", "Client"]);
    expect(readApiKeyPool(renamed)[1]?.secret).toBe(SECOND);
  });

  it("replaces one key's secret and keeps its label and place", () => {
    const { stored, ids } = poolWithTwoKeys();
    const replaced = replaceApiKeySecret(stored, ids[0] ?? "", "sk-rotated-2222");
    expect(readApiKeyPool(replaced).map((key) => key.secret)).toEqual(["sk-rotated-2222", SECOND]);
    expect(listApiKeys(replaced).map((key) => key.label)).toEqual(["Work", "Personal"]);
  });

  it("removes one key and keeps the others in order", () => {
    const { stored, ids } = poolWithTwoKeys();
    const removed = removeApiKey(stored, ids[0] ?? "");
    expect(listApiKeys(removed ?? "").map((key) => key.label)).toEqual(["Personal"]);
  });

  it("returns nothing when the last key is removed, so the entry is deleted", () => {
    const only = addApiKey(undefined, { secret: FIRST, label: "Only" });
    expect(removeApiKey(only.stored, only.key.id)).toBeUndefined();
  });

  it("refuses to change a key that is not in the pool", () => {
    const { stored } = poolWithTwoKeys();
    expect(refusalOf(() => renameApiKey(stored, "00000000-0000-4000-8000-000000000000", "X"))).toBe(
      "unknown-key",
    );
  });

  it("treats a stored value that is not a pool as a plain key", () => {
    const grant = JSON.stringify({
      kind: "subscription-oauth",
      credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
      descriptorId: "openai",
      accountLabel: "Henrik",
    });
    expect(readApiKeyPool(grant)).toEqual([{ id: "default", label: "Default", secret: grant }]);
  });

  it("holds no editable keys in a sign-in grant, so adding a key replaces the grant", () => {
    const grant = JSON.stringify({
      kind: "subscription-oauth",
      credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
      descriptorId: "openai",
      accountLabel: "Henrik",
    });
    expect(listApiKeys(grant)).toEqual([]);
    const added = addApiKey(grant, { secret: FIRST, label: "Work" });
    expect(readApiKeyPool(added.stored)).toEqual([
      expect.objectContaining({ label: "Work", secret: FIRST }),
    ]);
  });

  it("refuses a stored pool whose JSON is damaged rather than guessing a key", () => {
    const damaged = JSON.stringify({ kind: "api-key-pool", version: 1, keys: [{ id: "x" }] });
    expect(refusalOf(() => readApiKeyPool(damaged))).toBe("corrupt");
  });
});

describe("key selection", () => {
  const entries = [
    { id: "a", label: "Work", secret: "sk-a" },
    { id: "b", label: "Personal", secret: "sk-b" },
  ];

  it("uses the first key when nothing is cooling", () => {
    expect(selectApiKey(entries, new Map(), 1_000)?.id).toBe("a");
  });

  it("skips a cooling key and uses the next one in order", () => {
    const cooling = new Map([["a", 5_000]]);
    expect(selectApiKey(entries, cooling, 1_000)?.id).toBe("b");
  });

  it("returns to the first key once its cooldown has passed", () => {
    const cooling = new Map([["a", 5_000]]);
    expect(selectApiKey(entries, cooling, 6_000)?.id).toBe("a");
  });

  it("uses the key that recovers first when every key is cooling", () => {
    const cooling = new Map([
      ["a", 9_000],
      ["b", 4_000],
    ]);
    expect(selectApiKey(entries, cooling, 1_000)?.id).toBe("b");
  });
});

describe("refusal classification", () => {
  it("cools a key for an hour when the body says its credit or spend is used up", () => {
    expect(
      keyCooldownMs({ status: 400, body: "Your credit balance is too low to access the API" }),
    ).toBe(QUOTA_COOLDOWN_MS);
    expect(
      keyCooldownMs({
        status: 429,
        body: '{"error":{"details":{"error_code":"enforced_spend_limit_reached"}}}',
      }),
    ).toBe(QUOTA_COOLDOWN_MS);
    expect(keyCooldownMs({ status: 429, body: '{"code":"insufficient_quota"}' })).toBe(
      QUOTA_COOLDOWN_MS,
    );
    expect(keyCooldownMs({ status: 402, body: "" })).toBe(QUOTA_COOLDOWN_MS);
  });

  it("cools a key for a minute on a plain rate limit", () => {
    expect(keyCooldownMs({ status: 429, body: "rate limited" })).toBe(RATE_LIMIT_COOLDOWN_MS);
  });

  it("honours a Retry-After on a plain rate limit, capped at ten minutes", () => {
    expect(keyCooldownMs({ status: 429, body: "", retryAfterSeconds: 7 })).toBe(7_000);
    expect(keyCooldownMs({ status: 429, body: "", retryAfterSeconds: 3_600 })).toBe(600_000);
  });

  it("does not switch keys for a bad key, a forbidden request, or a malformed one", () => {
    expect(keyCooldownMs({ status: 401, body: "invalid x-api-key" })).toBeUndefined();
    expect(keyCooldownMs({ status: 403, body: "forbidden" })).toBeUndefined();
    expect(keyCooldownMs({ status: 400, body: "messages: field required" })).toBeUndefined();
    expect(keyCooldownMs({ status: 503, body: "overloaded" })).toBeUndefined();
  });

  it("reads Retry-After only as whole seconds", () => {
    expect(parseRetryAfterSeconds("12")).toBe(12);
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
  });
});
