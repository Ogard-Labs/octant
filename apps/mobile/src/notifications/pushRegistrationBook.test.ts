import { describe, expect, it } from "vitest";
import { createPushRegistrationBook, digestPlatformToken } from "./pushRegistrationBook";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("octant.mobile.push-registrations.v1", initial);
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    deleteItem: async (key: string) => void values.delete(key),
  };
}

const record = (hostId: string, tokenDigest = "a".repeat(64)) => ({
  hostId,
  deviceId: "device",
  hostKeyFingerprint: "f".repeat(64),
  tokenDigest,
});

describe("the record of computers this phone registered notifications with", () => {
  it("keeps one record per computer, replaces it when the token changes, and drops it on removal", async () => {
    const store = storage();
    const book = createPushRegistrationBook(store);
    await book.record(record("one"));
    await book.record(record("two"));
    await book.record(record("one", "b".repeat(64)));
    expect(await book.list()).toEqual([record("two"), record("one", "b".repeat(64))]);
    await book.remove("one");
    await book.remove("two");
    expect(await book.list()).toEqual([]);
    expect(store.values.size).toBe(0);
  });

  it("does not lose a record when changes overlap", async () => {
    const book = createPushRegistrationBook(storage());
    await Promise.all(["a", "b", "c", "d"].map((hostId) => book.record(record(hostId))));
    expect((await book.list()).map((entry) => entry.hostId).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("reads a damaged record as empty rather than rotating on a guess", async () => {
    for (const damaged of ["not json", "{}", JSON.stringify([{ hostId: "one" }])]) {
      expect(await createPushRegistrationBook(storage(damaged)).list()).toEqual([]);
    }
  });

  it("digests a token without keeping it", async () => {
    const digest = await digestPlatformToken("secret-token");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("secret");
    expect(await digestPlatformToken("secret-token")).toBe(digest);
    expect(await digestPlatformToken("other-token")).not.toBe(digest);
  });
});
