import { decodeBrowserCredentialHostResult } from "@octant/contracts/browser-credential-use";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startCredentialBroker,
  type CredentialBroker,
  type BrowserCredentialFillHostPort,
} from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { makeFakeOnePassword, type FakeOnePassword } from "./fakeOnePassword.test-support";
import {
  type LinkedSecretStoreAdapter,
  makeLinkedSecretStores,
  makeOnePasswordAdapter,
} from "./linkedSecretStores";

const REFERENCE = "op://Private/Provider key/credential";
const VALUE = "fixture-linked-value-91be";
const instanceId = randomUUID();
const secretId = randomUUID();

function memoryStore(): CredentialStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    set: async (id, value) => void entries.set(id, value),
    has: async (id) => entries.has(id),
    resolve: async (id) => {
      const value = entries.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void entries.delete(id),
  };
}

interface Harness {
  readonly broker: CredentialBroker;
  readonly op: FakeOnePassword;
  readonly provider: ReturnType<typeof memoryStore>;
  readonly connectors: ReturnType<typeof memoryStore>;
  readonly others: ReturnType<typeof memoryStore>;
  readonly post: (path: string, body: unknown) => Promise<{ status: number; text: string }>;
}

const brokers: CredentialBroker[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

async function harness(
  adapter?: LinkedSecretStoreAdapter,
  fill?: BrowserCredentialFillHostPort,
): Promise<Harness> {
  const op = makeFakeOnePassword();
  op.addItem(REFERENCE, VALUE);
  const provider = memoryStore();
  const connectors = memoryStore();
  const others = memoryStore();
  const linked = makeLinkedSecretStores({
    statePath: join(mkdtempSync(join(tmpdir(), "octant-broker-linked-")), "state.json"),
    adapters: [
      adapter ?? makeOnePasswordAdapter({ executablePath: op.executablePath, env: op.env }),
    ],
  });
  const broker = await startCredentialBroker(
    provider,
    undefined,
    undefined,
    others,
    others,
    others,
    connectors,
    others,
    others,
    linked,
    undefined,
    fill,
  );
  brokers.push(broker);
  return {
    broker,
    op,
    provider,
    connectors,
    others,
    post: async (path, body) => {
      const response = await broker.fetchForTest(
        new Request(new URL(path, broker.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-credential-broker-token": broker.token,
          },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, text: await response.text() };
    },
  };
}

const point = (id = instanceId, namespace = "provider", reference = REFERENCE) => ({
  namespace,
  id,
  store: "onepassword",
  reference,
});

// Each case starts real child processes, which are slow on a busy machine.
describe("credential broker linked secret stores", { timeout: 30_000 }, () => {
  it("resolves a card reference privately without storing a reusable credential", async () => {
    const h = await harness();
    const path = "/v1/secret-stores/request-card-read";
    const reference = { store: "onepassword", reference: REFERENCE };
    const unauthenticated = await h.broker.fetchForTest(
      new Request(new URL(path, h.broker.url), { method: "POST", body: JSON.stringify(reference) }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(JSON.parse((await h.post(path, reference)).text)).toEqual({ status: "not-linked" });
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    expect(JSON.parse((await h.post(path, reference)).text)).toEqual({
      status: "read",
      value: VALUE,
    });
    expect(h.provider.entries.size + h.connectors.entries.size + h.others.entries.size).toBe(0);
    expect(
      (await h.post(path, { ...reference, destination: "https://evil.test" })).text,
    ).not.toContain(VALUE);
    await h.post("/v1/secret-stores/unlink", { store: "onepassword" });
    expect(JSON.parse((await h.post(path, reference)).text)).toEqual({ status: "not-linked" });
  });
  it("discards a late card lookup after the store is unlinked and linked again", async () => {
    const read = Promise.withResolvers<{ status: "read"; value: string }>();
    const started = Promise.withResolvers<void>();
    const h = await harness({
      kind: "onepassword",
      label: "Fixture",
      probe: async () => "ready",
      isValidReference: () => true,
      read: () => {
        started.resolve();
        return read.promise;
      },
    });
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    const pending = h.post("/v1/secret-stores/request-card-read", {
      store: "onepassword",
      reference: REFERENCE,
    });
    await started.promise;
    await h.post("/v1/secret-stores/unlink", { store: "onepassword" });
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    read.resolve({ status: "read", value: VALUE });
    expect(JSON.parse((await pending).text)).toEqual({ status: "changed" });
  });

  it("authenticates fixed fill commands and refuses secret-bearing requests and responses", async () => {
    const ready = decodeBrowserCredentialHostResult({ status: "ready", custodyId: randomUUID() });
    const execute = vi.fn(async () => ready);
    const h = await harness(undefined, { execute, close: () => undefined });
    const command = {
      kind: "cancel-browser-credential-fill",
      contextId: randomUUID(),
      planId: randomUUID(),
      owner: { windowId: randomUUID(), threadId: randomUUID() },
    };
    const unauthenticated = await h.broker.fetchForTest(
      new Request(new URL("/v1/secret-stores/browser-fill", h.broker.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(
      (await h.post("/v1/secret-stores/browser-fill", { ...command, password: "fixture-private" }))
        .status,
    ).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(await h.post("/v1/secret-stores/browser-fill", command)).toEqual({
      status: 200,
      text: JSON.stringify(ready),
    });
    execute.mockImplementationOnce(async () => ({ ...ready, password: "fixture-private" }));
    const refused = await h.post("/v1/secret-stores/browser-fill", command);
    expect(JSON.parse(refused.text)).toEqual({ status: "refused", reason: "unavailable" });
    expect(refused.text).not.toContain("fixture-private");
  });

  it("returns selected-item metadata through the authenticated broker without changing legacy pointers", async () => {
    const item = {
      store: "onepassword" as const,
      accountId: "a".repeat(26),
      vaultId: "v".repeat(26),
      itemId: "i".repeat(26),
    };
    const metadata = vi.fn(async () => ({
      status: "described" as const,
      item,
      title: "Fixture",
      version: 1,
      websiteOrigins: ["https://login.example"],
    }));
    const h = await harness({
      kind: "onepassword",
      label: "Fixture",
      isValidReference: () => true,
      probe: async () => "ready",
      read: async () => ({ status: "unavailable" }),
      browserMetadata: metadata,
    });
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    const answer = await h.post("/v1/secret-stores/browser-metadata", item);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toMatchObject({
      status: "described",
      item,
      title: "Fixture",
      version: 1,
      storeRevision: expect.any(String),
    });
    expect(metadata).toHaveBeenCalledWith(item);
    const invalid = await h.post("/v1/secret-stores/browser-metadata", {
      ...item,
      password: "fixture",
    });
    expect(invalid.status).toBe(400);
    expect(metadata).toHaveBeenCalledOnce();
  });

  it("follows a pointer at use and keeps only the pointer in the credential store", async () => {
    const h = await harness();
    expect((await h.post("/v1/secret-stores/link", { store: "onepassword" })).text).toBe(
      JSON.stringify({ status: "linked" }),
    );
    expect(await h.post("/v1/secret-stores/point", point())).toEqual({
      status: 200,
      text: JSON.stringify({ status: "pointed" }),
    });

    const resolved = await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    expect(resolved.status).toBe(200);
    expect(JSON.parse(resolved.text)).toEqual({ credential: VALUE });
    expect(await h.post("/v1/credentials/has", { providerInstanceId: instanceId })).toEqual({
      status: 200,
      text: JSON.stringify({ present: true }),
    });
    expect([...h.provider.entries.values()].join("\n")).not.toContain(VALUE);
    expect(h.provider.entries.get(instanceId)).toContain(REFERENCE);
  });

  it("fetches the value again on every use, so a rotated item is picked up and nothing is cached", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    await h.post("/v1/secret-stores/point", point());
    await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    h.op.addItem(REFERENCE, "rotated-value-5521");
    const again = await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    expect(JSON.parse(again.text)).toEqual({ credential: "rotated-value-5521" });
    expect(h.op.calls().filter((call) => call.startsWith("read "))).toHaveLength(3);
  });

  it("also serves a connector credential, and only the provider and connector namespaces", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    expect((await h.post("/v1/secret-stores/point", point(secretId, "mcp-server"))).status).toBe(
      200,
    );
    const resolved = await h.post("/v1/mcp-server-credentials/resolve", { secretId });
    expect(JSON.parse(resolved.text)).toEqual({ credential: VALUE });

    // Another namespace holding the same string never follows it.
    h.others.entries.set(secretId, h.connectors.entries.get(secretId) ?? "missing-pointer-fixture");
    const other = await h.post("/v1/desktop-provider-credentials/resolve", {
      credentialRef: secretId,
    });
    expect(other.text).not.toContain(VALUE);
    expect(
      (await h.post("/v1/secret-stores/point", point(secretId, "desktop-provider"))).status,
    ).toBe(400);
  });

  it("reports a locked store plainly and returns no value", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    await h.post("/v1/secret-stores/point", point());
    h.op.setMode("locked");
    const resolved = await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    expect(resolved.status).toBe(503);
    expect(JSON.parse(resolved.text)).toEqual({
      error: "unavailable",
      cause: "linked-store-locked",
    });
    expect(resolved.text).not.toContain(VALUE);
  });

  it("reports a missing item and an unavailable tool, each with its own cause", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    await h.post("/v1/secret-stores/point", point());
    h.provider.entries.set(
      instanceId,
      `octant-linked-secret:v1:${JSON.stringify({ store: "onepassword", reference: "op://Private/Gone/credential" })}`,
    );
    const missing = await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text)).toEqual({ error: "missing", cause: "linked-item-missing" });

    h.provider.entries.set(instanceId, "octant-linked-secret:v1:{broken");
    const broken = await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    expect(broken.status).toBe(503);
    expect(JSON.parse(broken.text).cause).toBe("linked-store-unavailable");
  });

  it("fails closed once the store is unlinked, leaving the pointer in place", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    await h.post("/v1/secret-stores/point", point());
    await h.post("/v1/secret-stores/unlink", { store: "onepassword" });
    const resolved = await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId });
    expect(resolved.status).toBe(503);
    expect(JSON.parse(resolved.text).cause).toBe("linked-store-not-linked");
    expect(h.provider.entries.has(instanceId)).toBe(true);
  });

  it("refuses to point at a store that is not linked, locked, or has no such item, and writes nothing", async () => {
    const h = await harness();
    expect(JSON.parse((await h.post("/v1/secret-stores/point", point())).text)).toEqual({
      status: "not-linked",
    });
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    expect(
      JSON.parse(
        (
          await h.post(
            "/v1/secret-stores/point",
            point(instanceId, "provider", "op://Private/No/x"),
          )
        ).text,
      ),
    ).toEqual({ status: "missing" });
    h.op.setMode("locked");
    expect(JSON.parse((await h.post("/v1/secret-stores/point", point())).text)).toEqual({
      status: "locked",
    });
    expect(h.provider.entries.size).toBe(0);
  });

  it("never replaces a key the person stored, but replaces and clears its own pointer", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    h.provider.entries.set(instanceId, "sk-stored-by-person");
    expect(JSON.parse((await h.post("/v1/secret-stores/point", point())).text)).toEqual({
      status: "key-already-stored",
    });
    expect(h.provider.entries.get(instanceId)).toBe("sk-stored-by-person");
    expect(
      JSON.parse(
        (await h.post("/v1/secret-stores/clear", { namespace: "provider", id: instanceId })).text,
      ),
    ).toEqual({ status: "none" });
    expect(h.provider.entries.get(instanceId)).toBe("sk-stored-by-person");

    h.provider.entries.delete(instanceId);
    await h.post("/v1/secret-stores/point", point());
    h.op.addItem("op://Private/Second/credential", "second-value");
    expect(
      (
        await h.post(
          "/v1/secret-stores/point",
          point(instanceId, "provider", "op://Private/Second/credential"),
        )
      ).text,
    ).toBe(JSON.stringify({ status: "pointed" }));
    const reference = JSON.parse(
      (await h.post("/v1/secret-stores/reference", { namespace: "provider", id: instanceId })).text,
    );
    expect(reference).toEqual({
      status: "linked",
      store: "onepassword",
      reference: "op://Private/Second/credential",
    });
    const cleared = JSON.parse(
      (await h.post("/v1/secret-stores/clear", { namespace: "provider", id: instanceId })).text,
    );
    expect(cleared.status).toBe("cleared");
    expect(h.provider.entries.has(instanceId)).toBe(false);
  });

  it("restores an earlier pointer without reading its item, and never over a stored key or into an unlinked store", async () => {
    const h = await harness();
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    const callsBefore = h.op.calls().length;
    h.op.setMode("locked");
    expect(await h.post("/v1/secret-stores/restore", point())).toEqual({
      status: 200,
      text: JSON.stringify({ status: "pointed" }),
    });
    // No item was read, though the store is locked.
    expect(h.op.calls().length).toBe(callsBefore);
    expect(h.provider.entries.get(instanceId)).toContain(REFERENCE);

    h.provider.entries.set(instanceId, "sk-stored-by-person");
    expect(JSON.parse((await h.post("/v1/secret-stores/restore", point())).text)).toEqual({
      status: "key-already-stored",
    });
    expect(h.provider.entries.get(instanceId)).toBe("sk-stored-by-person");

    h.provider.entries.delete(instanceId);
    await h.post("/v1/secret-stores/unlink", { store: "onepassword" });
    expect(JSON.parse((await h.post("/v1/secret-stores/restore", point())).text)).toEqual({
      status: "not-linked",
    });
    expect(h.provider.entries.size).toBe(0);
    expect(
      JSON.parse(
        (await h.post("/v1/secret-stores/restore", point(instanceId, "provider", "--help"))).text,
      ),
    ).toEqual({ status: "invalid-reference" });
  });

  it("refuses to store a pasted value that would pass for a pointer", async () => {
    const h = await harness();
    const pasted = await h.post("/v1/credentials/set", {
      providerInstanceId: instanceId,
      credential: "octant-linked-secret:v1:{}",
    });
    expect(pasted.status).toBe(400);
    expect(h.provider.entries.size).toBe(0);
  });

  it("never lets the value reach a response other than the owner's resolve, a log line, or the credential store", async () => {
    const h = await harness();
    const written: string[] = [];
    for (const channel of ["stdout", "stderr"] as const) {
      vi.spyOn(process[channel], "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      });
    }
    const answers = [
      await h.post("/v1/secret-stores/status", {}),
      await h.post("/v1/secret-stores/link", { store: "onepassword" }),
      await h.post("/v1/secret-stores/check", { store: "onepassword", reference: REFERENCE }),
      await h.post("/v1/secret-stores/point", point()),
      await h.post("/v1/secret-stores/reference", { namespace: "provider", id: instanceId }),
      await h.post("/v1/credentials/has", { providerInstanceId: instanceId }),
      await h.post("/v1/secret-stores/clear", { namespace: "provider", id: instanceId }),
      await h.post("/v1/secret-stores/unlink", { store: "onepassword" }),
    ];
    await h.post("/v1/secret-stores/link", { store: "onepassword" });
    await h.post("/v1/secret-stores/point", point());
    h.op.setMode("locked");
    answers.push(await h.post("/v1/credentials/resolve", { providerInstanceId: instanceId }));

    expect(answers.map((answer) => answer.text).join("\n")).not.toContain(VALUE);
    expect(written.join("\n")).not.toContain(VALUE);
    expect([...h.provider.entries.values()].join("\n")).not.toContain(VALUE);
  });

  it("answers 404 for the linked-store routes when the host links no stores", async () => {
    const broker = await startCredentialBroker(memoryStore());
    brokers.push(broker);
    const response = await broker.fetchForTest(
      new Request(new URL("/v1/secret-stores/status", broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(404);
  });
});
