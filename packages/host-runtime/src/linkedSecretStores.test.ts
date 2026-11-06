import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeFakeOnePassword } from "./fakeOnePassword.test-support";
import {
  decodeLinkedSecretPointer,
  encodeLinkedSecretPointer,
  makeLinkedSecretStores,
  makeOnePasswordAdapter,
} from "./linkedSecretStores";

const REFERENCE = "op://Private/Provider key/credential";
const VALUE = "fixture-linked-value-7f3a";

function fixture() {
  const op = makeFakeOnePassword();
  const directory = mkdtempSync(join(tmpdir(), "octant-linked-state-"));
  const statePath = join(directory, "secret-stores", "linked-secret-stores.json");
  const stores = makeLinkedSecretStores({
    statePath,
    adapters: [makeOnePasswordAdapter({ executablePath: op.executablePath, env: op.env })],
  });
  op.addItem(REFERENCE, VALUE);
  return { op, stores, statePath };
}

// Each case starts real child processes, which are slow on a busy machine.
describe("linked secret stores", { timeout: 30_000 }, () => {
  it("never consumes a credential from an item read that overlapped unlink and same-time relink", async () => {
    const item = {
      store: "onepassword" as const,
      accountId: "a".repeat(26),
      vaultId: "v".repeat(26),
      itemId: "i".repeat(26),
    };
    const answer = {
      status: "described" as const,
      item,
      title: "Fixture",
      version: 1,
      websiteOrigins: ["https://login.example"],
    };
    let finish: (() => void) | undefined;
    const stores = makeLinkedSecretStores({
      statePath: join(mkdtempSync(join(tmpdir(), "octant-browser-consume-")), "state.json"),
      now: () => "2026-11-03T10:00:00.000Z",
      adapters: [
        {
          kind: "onepassword",
          label: "Fixture",
          probe: async () => "ready",
          isValidReference: () => true,
          read: async () => ({ status: "missing" }),
          browserMetadata: async () => answer,
          consumeBrowserCredential: async (_metadata, consume) => {
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            await consume({ username: "fixture-user", password: "fixture-private" });
            return { status: "consumed" };
          },
        },
      ],
    });
    await stores.link("onepassword");
    const metadata = await stores.browserMetadata?.(item);
    if (metadata?.status !== "described") throw new Error("Expected selected metadata");
    const use = vi.fn(async () => undefined);
    const pending = stores.consumeBrowserCredential?.(metadata, use);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await stores.unlink("onepassword");
    await stores.link("onepassword");
    finish?.();
    expect(await pending).toEqual({ status: "changed" });
    expect(use).not.toHaveBeenCalled();
    expect(stores.browserRevisionCurrent?.(metadata.storeRevision)).toBe(false);
  });
  it("refuses delayed metadata after unlink and relink even at the same recorded link time", async () => {
    const item = {
      store: "onepassword" as const,
      accountId: "a".repeat(26),
      vaultId: "v".repeat(26),
      itemId: "i".repeat(26),
    };
    const answer = {
      status: "described" as const,
      item,
      title: "Fixture",
      version: 1,
      websiteOrigins: ["https://login.example"],
    };
    const metadata = vi.fn(async () => answer);
    const stores = makeLinkedSecretStores({
      statePath: join(mkdtempSync(join(tmpdir(), "octant-browser-link-")), "state.json"),
      now: () => "2026-11-03T10:00:00.000Z",
      adapters: [
        {
          kind: "onepassword",
          label: "Fixture",
          probe: async () => "ready",
          isValidReference: () => true,
          read: async () => ({ status: "unavailable" }),
          browserMetadata: metadata,
        },
      ],
    });
    await stores.link("onepassword");
    const first = await stores.browserMetadata?.(item);
    let finish: (() => void) | undefined;
    let started: (() => void) | undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    metadata.mockImplementationOnce(async () => {
      started?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return answer;
    });
    const pending = stores.browserMetadata?.(item);
    await begun;
    await stores.unlink("onepassword");
    await stores.link("onepassword");
    finish?.();
    expect(await pending).toEqual({ status: "changed" });
    const after = await stores.browserMetadata?.(item);
    expect(first).toMatchObject({ status: "described" });
    expect(after).toMatchObject({ status: "described" });
    if (first?.status !== "described" || after?.status !== "described")
      throw new Error("Missing metadata fixture");
    expect(after.storeRevision).not.toBe(first.storeRevision);
    expect(
      decodeLinkedSecretPointer(
        "octant-linked-secret:v1:" +
          JSON.stringify({ store: "onepassword", reference: REFERENCE, accountId: item.accountId }),
      ),
    ).toBeUndefined();
  });

  it("links the 1Password CLI only while it is unlocked, and reports why otherwise", async () => {
    const { op, stores } = fixture();
    op.setMode("locked");
    expect(await stores.link("onepassword")).toEqual({ status: "locked" });
    expect(await stores.isLinked("onepassword")).toBe(false);

    op.setMode("ready");
    expect(await stores.link("onepassword")).toEqual({ status: "linked" });
    expect(await stores.isLinked("onepassword")).toBe(true);
    expect((await stores.status())[0]).toMatchObject({
      kind: "onepassword",
      label: "1Password",
      linked: true,
      tool: "ready",
    });

    await stores.unlink("onepassword");
    expect(await stores.isLinked("onepassword")).toBe(false);
  });

  it("reports a missing command line tool without linking", async () => {
    const stores = makeLinkedSecretStores({
      statePath: join(mkdtempSync(join(tmpdir(), "octant-linked-state-")), "state.json"),
      adapters: [makeOnePasswordAdapter({ executablePath: "/nonexistent/op", env: {} })],
    });
    expect(await stores.link("onepassword")).toEqual({ status: "not-installed" });
    expect((await stores.status())[0]).toMatchObject({ linked: false, tool: "not-installed" });
  });

  it("reads a linked item and answers a locked store, a missing item, and a broken tool as values", async () => {
    const { op, stores } = fixture();
    await stores.link("onepassword");

    expect(await stores.read("onepassword", REFERENCE)).toEqual({ status: "read", value: VALUE });
    expect(await stores.check("onepassword", REFERENCE)).toEqual({ status: "found" });
    expect(await stores.read("onepassword", "op://Private/Absent/credential")).toEqual({
      status: "missing",
    });

    op.setMode("locked");
    expect(await stores.read("onepassword", REFERENCE)).toEqual({ status: "locked" });
    op.setMode("broken");
    expect(await stores.read("onepassword", REFERENCE)).toEqual({ status: "unavailable" });
  });

  it("fails closed when the store is not linked, without running the tool", async () => {
    const { op, stores } = fixture();
    expect(await stores.read("onepassword", REFERENCE)).toEqual({ status: "not-linked" });
    expect(await stores.check("onepassword", REFERENCE)).toEqual({ status: "not-linked" });
    expect(op.calls()).toEqual([]);
  });

  it("refuses a reference that is not an item address before it reaches the tool", async () => {
    const { op, stores } = fixture();
    await stores.link("onepassword");
    const before = op.calls().length;
    for (const reference of [
      "--help",
      "op://vault",
      "op://vault/item",
      "op://vault/item/field\nextra",
      "op://vault/item/field/section/more",
      "https://example.com/x/y/z",
      `op://v/i/${"f".repeat(600)}`,
    ]) {
      expect(await stores.read("onepassword", reference)).toEqual({ status: "invalid-reference" });
    }
    expect(op.calls().length).toBe(before);
  });

  it("passes the reference as one argument and hides Octant's own variables from the tool", async () => {
    const { op, stores } = fixture();
    await stores.link("onepassword");
    await stores.read("onepassword", REFERENCE);
    expect(op.calls().at(-1)).toBe(`read --no-newline ${REFERENCE}|octant=0`);
  });

  it("keeps only the store name and link time on disk, never an item or its value", async () => {
    const { stores, statePath } = fixture();
    await stores.link("onepassword");
    await stores.read("onepassword", REFERENCE);
    const text = readFileSync(statePath, "utf8");
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain("op://");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("treats an unreadable record as nothing linked", async () => {
    const { stores, statePath } = fixture();
    await stores.link("onepassword");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, "{not json");
    expect(await stores.isLinked("onepassword")).toBe(false);
  });

  it("encodes a pointer that decodes only to a closed store and a plain reference", () => {
    const encoded = encodeLinkedSecretPointer({ store: "onepassword", reference: REFERENCE });
    expect(decodeLinkedSecretPointer(encoded)).toEqual({
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(decodeLinkedSecretPointer("sk-plain-key")).toBeUndefined();
    expect(
      decodeLinkedSecretPointer(`octant-linked-secret:v1:{"store":"other","reference":"x"}`),
    ).toBeUndefined();
    expect(decodeLinkedSecretPointer("octant-linked-secret:v1:{broken")).toBeUndefined();
  });
});
