import { describe, expect, it } from "vitest";
import { isMobileHighRiskPromptActive } from "../security/mobileAuthPromptState";
import { createPhoneUnlockKey, type UnlockKeyRead } from "./ownerUnlockKey";

type Presence = "confirmed" | "denied" | "unavailable";

function fixture(options: { presence?: Presence; vaultRead?: UnlockKeyRead } = {}) {
  let storedPrivate: string | undefined;
  let storedPublic: string | null = null;
  const counts = { authenticate: 0, vaultRead: 0 };
  const order: string[] = [];
  const active = { presence: false, vault: false };
  const key = createPhoneUnlockKey({
    vault: {
      read: async () => {
        counts.vaultRead += 1;
        order.push("vault");
        active.vault = isMobileHighRiskPromptActive();
        if (options.vaultRead !== undefined) return options.vaultRead;
        return storedPrivate === undefined
          ? { status: "missing" }
          : { status: "read", pkcs8: storedPrivate };
      },
      write: async (value) => {
        storedPrivate = value;
      },
      remove: async () => {
        storedPrivate = undefined;
      },
    },
    publicKey: {
      get: async () => storedPublic,
      set: async (value) => {
        storedPublic = value;
      },
      remove: async () => {
        storedPublic = null;
      },
    },
    presence: {
      authenticate: async () => {
        counts.authenticate += 1;
        order.push("presence");
        active.presence = isMobileHighRiskPromptActive();
        return options.presence ?? "confirmed";
      },
    },
  });
  return {
    key,
    counts,
    order,
    active,
    stored: () => ({ private: storedPrivate, public: storedPublic }),
  };
}

async function verifies(publicKey: string, text: string, signature: string): Promise<boolean> {
  const bytes = (value: string) =>
    Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const imported = await crypto.subtle.importKey(
    "spki",
    bytes(publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    imported,
    bytes(signature),
    new TextEncoder().encode(text),
  );
}

describe("phone unlock key", () => {
  it("makes the key without asking the person and shows only its public half", async () => {
    const { key, counts, stored } = fixture();

    const made = await key.ensure();

    expect(counts).toEqual({ authenticate: 0, vaultRead: 0 });
    expect(Object.keys(made).sort()).toEqual(["fingerprint", "publicKey"]);
    expect(made.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored().public).toBe(made.publicKey);
    expect(stored().private).toBeDefined();
    expect(JSON.stringify(made)).not.toContain(stored().private ?? "unreachable");
  });

  it("keeps the same key on the next use instead of making another", async () => {
    const { key } = fixture();
    const first = await key.ensure();
    expect((await key.ensure()).publicKey).toBe(first.publicKey);
  });

  it("opens the key only after the person passes the system prompt, then reads the store", async () => {
    const { key, order } = fixture();
    const made = await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    const opened = await signer.open();

    expect(order).toEqual(["presence", "vault"]);
    expect(opened.status).toBe("signed");
    if (opened.status !== "signed") return;
    const signature = await opened.value.sign("unlock text");
    expect(await verifies(made.publicKey, "unlock text", signature)).toBe(true);
  });

  it("asks the person once for an action however many texts it signs, and signs nothing once closed", async () => {
    const { key, counts } = fixture();
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    const opened = await signer.open();
    if (opened.status !== "signed") throw new Error("expected an open key");
    await opened.value.sign("confirmation");
    await opened.value.sign("unlock text");
    opened.value.close();

    expect(counts).toEqual({ authenticate: 1, vaultRead: 1 });
    await expect(opened.value.sign("again")).rejects.toThrow();
  });

  it("asks again when the next action opens the key", async () => {
    const { key, counts } = fixture();
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    await signer.open();
    await signer.open();

    expect(counts).toEqual({ authenticate: 2, vaultRead: 2 });
  });

  it("never reads the stored key when the person declines", async () => {
    const { key, counts } = fixture({ presence: "denied" });
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    expect(await signer.open()).toEqual({ status: "cancelled" });
    expect(counts.vaultRead).toBe(0);
  });

  it("never reads the stored key when the phone cannot ask the person", async () => {
    const { key, counts } = fixture({ presence: "unavailable" });
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    expect(await signer.open()).toEqual({ status: "unavailable" });
    expect(counts.vaultRead).toBe(0);
  });

  it("treats a store that will not release the key as a cancelled unlock", async () => {
    const { key } = fixture({ vaultRead: { status: "refused" } });
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    expect(await signer.open()).toEqual({ status: "cancelled" });
  });

  it("holds the high-risk prompt guard through the system prompt and the store read, then lets go", async () => {
    const { key, active } = fixture();
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    await signer.open();

    expect(active).toEqual({ presence: true, vault: true });
    expect(isMobileHighRiskPromptActive()).toBe(false);
  });

  it("lets go of the high-risk prompt guard when the person declines", async () => {
    const { key } = fixture({ presence: "denied" });
    await key.ensure();
    const signer = await key.signer();
    if (signer?.shape !== "raw") throw new Error("expected a raw signer");

    await signer.open();

    expect(isMobileHighRiskPromptActive()).toBe(false);
  });

  it("offers no signer until a key exists and none after the key is forgotten", async () => {
    const { key, stored } = fixture();
    expect(await key.signer()).toBeUndefined();
    await key.ensure();
    expect(await key.signer()).toBeDefined();

    await key.forget();

    expect(await key.signer()).toBeUndefined();
    expect(stored()).toEqual({ private: undefined, public: null });
  });
});
