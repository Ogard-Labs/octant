import { describe, expect, it } from "vitest";
import { decodeProviderKeyJournalRecord } from "./providerKeyJournal";

const REQUEST = "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19";
const INSTANCE = "80000000-0000-4000-8000-000000000401";
const WINDOW = "33333333-3333-4333-8333-333333333333";

describe("provider key journal records", () => {
  it("decodes a request, a completion and a failure", () => {
    const base = { requestId: REQUEST, instanceId: INSTANCE, action: "set" };
    expect(
      decodeProviderKeyJournalRecord({
        name: "provider-key.change-requested",
        ...base,
        instanceVersion: 3,
        windowId: WINDOW,
      }).name,
    ).toBe("provider-key.change-requested");
    expect(
      decodeProviderKeyJournalRecord({
        name: "provider-key.change-completed",
        ...base,
        outcome: "stored",
      }).name,
    ).toBe("provider-key.change-completed");
    expect(
      decodeProviderKeyJournalRecord({
        name: "provider-key.change-failed",
        ...base,
        reason: "credential-store-unavailable",
      }).name,
    ).toBe("provider-key.change-failed");
  });

  it("rejects a record that carries key material in any field", () => {
    for (const extra of ["credential", "key", "keyHash", "keyLength", "keyPrefix"]) {
      expect(() =>
        decodeProviderKeyJournalRecord({
          name: "provider-key.change-requested",
          requestId: REQUEST,
          instanceId: INSTANCE,
          action: "set",
          instanceVersion: 1,
          windowId: WINDOW,
          [extra]: "sk-secret",
        }),
      ).toThrow();
    }
  });

  it("rejects an action and an outcome it does not know", () => {
    expect(() =>
      decodeProviderKeyJournalRecord({
        name: "provider-key.change-completed",
        requestId: REQUEST,
        instanceId: INSTANCE,
        action: "export",
        outcome: "stored",
      }),
    ).toThrow();
  });
});
