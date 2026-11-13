import { describe, expect, it } from "vitest";
import { decodeProviderInstance, decodeWindowId, type ProviderInstance } from "@octant/contracts";
import { addApiKey } from "@octant/host-runtime";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ProviderKeyReference } from "./credentialBrokerClient";
import type { ProviderKeyJournal } from "./providerKeyJournal";
import { createProviderCredentialRouteHandler } from "./providerCredentialRoutes";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const KEY = "sk-test-0123456789";

const GATEWAY_ID = "80000000-0000-4000-8000-000000000401";
const OTHER_ID = "80000000-0000-4000-8000-000000000402";
const REMOVED_ID = "80000000-0000-4000-8000-000000000499";

function gateway(
  id: string,
  displayName: string,
  authentication: "bearer" | "none" = "bearer",
): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication,
      protocol: "auto",
      manualModelIds: ["model-a"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
  });
}

function setup(
  input: {
    readonly instances?: ProviderInstance[];
    readonly storeAvailable?: boolean;
    readonly failingStore?: boolean;
    readonly onReprobe?: (instance: ProviderInstance) => void;
    readonly failingCause?:
      | "locked"
      | "no-login-collection"
      | "no-service"
      | "no-tool"
      | "denied"
      | "timed-out";
    readonly onSet?: () => void;
    readonly journalFails?: boolean;
    readonly failDelete?: boolean;
    readonly onRefuse?: (instances: ProviderInstance[]) => void;
    readonly providerRefusal?: string;
    readonly onRemoveProvider?: (instance: ProviderInstance) => void;
    readonly keyReference?: ProviderKeyReference | { readonly rejects: unknown };
  } = {},
) {
  const records: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const journal: ProviderKeyJournal = {
    request: (request) => {
      if (input.journalFails === true) throw new Error("journal unavailable");
      const common = { instanceId: request.instanceId, action: request.action };
      records.push({
        name: "requested",
        ...common,
        windowId: request.windowId,
        ...(request.actor === undefined ? {} : { actor: request.actor }),
      });
      return {
        complete: (outcome) => records.push({ name: "completed", ...common, outcome }),
        fail: (reason) => records.push({ name: "failed", ...common, reason }),
      };
    },
    unsettled: () => [],
    settle: () => undefined,
  };
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const stored = new Map<string, string>();
  const instances = input.instances ?? [gateway(GATEWAY_ID, "Private gateway")];
  const fail = async (): Promise<never> => {
    throw {
      category: "unavailable",
      message: "The provider credential store is unavailable.",
      ...(input.failingCause === undefined ? {} : { cause: input.failingCause }),
    };
  };
  const handle = createProviderCredentialRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    readProviderInstances: () => instances,
    readRemovedProviderInstanceIds: () => [REMOVED_ID],
    journal,
    ...(input.keyReference === undefined
      ? {}
      : {
          readKeyReference: async () => {
            const reference = input.keyReference ?? { status: "none" };
            if ("rejects" in reference) throw reference.rejects;
            return reference;
          },
        }),
    reprobe: async (_window, instance) => input.onReprobe?.(instance),
    removeProvider: async (_window, instance) => {
      if (input.providerRefusal !== undefined) {
        input.onRefuse?.(instances);
        return { kind: "refused", message: input.providerRefusal };
      }
      input.onRemoveProvider?.(instance);
      const index = instances.indexOf(instance);
      if (index >= 0) instances.splice(index, 1);
      return { kind: "removed" };
    },
    credentials:
      input.storeAvailable === false
        ? undefined
        : {
            store:
              input.failingStore === true
                ? { has: fail, set: fail, delete: fail }
                : {
                    has: async (id) => stored.has(id),
                    set: async (id, value) => {
                      stored.set(id, value);
                      input.onSet?.();
                    },
                    delete: async (id) => {
                      if (input.failDelete === true) await fail();
                      stored.delete(id);
                    },
                  },
            readStored: async (id) => {
              reads.push(id);
              return stored.get(id) ?? "";
            },
          },
  });
  return { handle, stored, instances, records, reads };
}

function hostLocal(
  path: string,
  body: unknown,
  overrides: { readonly headers?: Record<string, string>; readonly host?: string } = {},
): Request {
  return new Request(`http://${overrides.host ?? "127.0.0.1:3773"}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      ...overrides.headers,
    },
    body: JSON.stringify(body),
  });
}

const SET = "/api/desktop/provider-credentials/set";
const STATUS = "/api/desktop/provider-credentials/status";
const REMOVE = "/api/desktop/provider-credentials/remove";
const REMOVE_PROVIDER = "/api/desktop/provider-credentials/remove-provider";

async function json(response: Response | undefined): Promise<{ status: number; body: unknown }> {
  if (response === undefined) throw new Error("route did not answer");
  return { status: response.status, body: await response.json() };
}

describe("host-local provider key routes", () => {
  it("stores a key from the host-local command and never answers with it", async () => {
    const { handle, stored } = setup();
    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );

    expect(result).toEqual({
      status: 200,
      body: { outcome: "stored", instanceId: GATEWAY_ID, displayName: "Private gateway" },
    });
    expect(JSON.stringify(result.body)).not.toContain(KEY);
    expect(stored.get(GATEWAY_ID)).toBe(KEY);
  });

  it("refuses a browser window that holds a capability but not the host's bridge secret", async () => {
    const { handle, stored } = setup();
    const result = await json(
      await handle(
        hostLocal(
          SET,
          { instance: GATEWAY_ID, credential: KEY, replace: false },
          { headers: { "x-octant-desktop-secret": "", origin: "http://127.0.0.1:3773" } },
        ),
      ),
    );

    expect(result.status).toBe(401);
    expect(stored.size).toBe(0);
  });

  it("refuses any request carrying a browser Origin even with the bridge secret", async () => {
    const { handle, stored } = setup();
    const response = await handle(
      hostLocal(
        SET,
        { instance: GATEWAY_ID, credential: KEY, replace: false },
        { headers: { origin: "http://127.0.0.1:3773" } },
      ),
    );

    expect(response?.status).toBe(401);
    expect(stored.size).toBe(0);
  });

  it("refuses a remote principal reaching the host by a non-loopback address", async () => {
    const { handle, stored } = setup();
    const response = await handle(
      hostLocal(
        SET,
        { instance: GATEWAY_ID, credential: KEY, replace: false },
        {
          host: "192.168.1.20:9443",
          headers: { "x-octant-device-proof": "proof", "x-octant-csrf": "token" },
        },
      ),
    );

    expect(response?.status).toBe(401);
    expect(stored.size).toBe(0);
  });

  it("refuses a caller with the bridge secret but no registered window capability", async () => {
    const { handle, stored } = setup();
    const response = await handle(
      hostLocal(
        SET,
        { instance: GATEWAY_ID, credential: KEY, replace: false },
        { headers: { "x-octant-window-capability": "B".repeat(43) } },
      ),
    );

    expect(response?.status).toBe(401);
    expect(stored.size).toBe(0);
  });

  it("fails closed when the server started without a credential store", async () => {
    const { handle } = setup({ storeAvailable: false });
    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ category: "credential-store-unavailable" });
  });

  it("reports a locked or unreachable store as unavailable without a fallback", async () => {
    const { handle } = setup({ failingStore: true });
    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ category: "credential-store-unavailable" });
  });

  it("passes on why the keyring refused, so the person can fix it", async () => {
    for (const cause of ["locked", "no-service", "no-tool", "denied", "timed-out"] as const) {
      const { handle } = setup({ failingStore: true, failingCause: cause });
      const result = await json(
        await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
      );

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ category: "credential-store-unavailable", cause });
    }
  });

  it("re-checks the provider once its key is stored or removed, so Needs key clears without a restart", async () => {
    const checked: string[] = [];
    const { handle } = setup({ onReprobe: (instance) => checked.push(String(instance.id)) });
    await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false }));
    await handle(hostLocal(REMOVE, { instance: GATEWAY_ID }));

    expect(checked).toEqual([GATEWAY_ID, GATEWAY_ID]);
  });

  it("will not overwrite a stored key unless replace is asked for", async () => {
    const { handle, stored } = setup();
    stored.set(GATEWAY_ID, "old-key");

    const refused = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );
    expect(refused).toMatchObject({ status: 409, body: { category: "already-stored" } });
    expect(stored.get(GATEWAY_ID)).toBe("old-key");

    const replaced = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: true })),
    );
    expect(replaced).toMatchObject({ status: 200, body: { outcome: "stored" } });
    expect(stored.get(GATEWAY_ID)).toBe(KEY);
  });

  it("refuses to replace a pool of several keys with one", async () => {
    const { handle, stored } = setup();
    const first = addApiKey(undefined, { secret: "key-one" }).stored;
    stored.set(GATEWAY_ID, addApiKey(first, { secret: "key-two" }).stored);
    const before = stored.get(GATEWAY_ID);

    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: true })),
    );

    expect(result).toMatchObject({ status: 409, body: { category: "several-keys" } });
    expect(stored.get(GATEWAY_ID)).toBe(before);
  });

  it("finds an instance by its exact name and lists the candidates when the name is shared", async () => {
    const unique = setup({ instances: [gateway(GATEWAY_ID, "Private gateway")] });
    expect(
      await json(await unique.handle(hostLocal(STATUS, { instance: "Private gateway" }))),
    ).toEqual({
      status: 200,
      body: { outcome: "missing", instanceId: GATEWAY_ID, displayName: "Private gateway" },
    });

    const shared = setup({
      instances: [gateway(GATEWAY_ID, "Gateway"), gateway(OTHER_ID, "Gateway")],
    });
    const result = await json(
      await shared.handle(hostLocal(SET, { instance: "Gateway", credential: KEY, replace: false })),
    );
    expect(result).toMatchObject({
      status: 409,
      body: {
        category: "ambiguous",
        candidates: [
          { id: GATEWAY_ID, displayName: "Gateway" },
          { id: OTHER_ID, displayName: "Gateway" },
        ],
      },
    });
    expect(shared.stored.size).toBe(0);
  });

  it("writes no key for an instance that does not authenticate with one", async () => {
    const { handle, stored } = setup({
      instances: [gateway(GATEWAY_ID, "Open gateway", "none")],
    });
    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );

    expect(result).toMatchObject({
      status: 409,
      body: { category: "no-stored-key-authentication" },
    });
    expect(stored.size).toBe(0);
  });

  it("refuses an empty or oversized key before it reaches the store", async () => {
    const { handle, stored } = setup();
    const empty = await handle(
      hostLocal(SET, { instance: GATEWAY_ID, credential: " \n", replace: false }),
    );
    const oversized = await handle(
      hostLocal(SET, {
        instance: GATEWAY_ID,
        credential: "k".repeat(12 * 1_024 + 1),
        replace: false,
      }),
    );

    expect(empty?.status).toBe(400);
    expect(oversized?.status).toBe(413);
    expect(stored.size).toBe(0);
  });

  it("clears the key a removed instance left behind, and refuses a name it never knew", async () => {
    const { handle, stored } = setup();
    stored.set(REMOVED_ID, "orphan");

    const removed = await json(await handle(hostLocal(REMOVE, { instance: REMOVED_ID })));
    expect(removed).toMatchObject({ status: 200, body: { outcome: "removed" } });
    expect(stored.has(REMOVED_ID)).toBe(false);

    const unknown = await handle(hostLocal(STATUS, { instance: REMOVED_ID }));
    expect(unknown?.status).toBe(404);
  });

  it("clears a key it just wrote when the endpoint was reconfigured during the write", async () => {
    const instances = [gateway(GATEWAY_ID, "Private gateway")];
    const { handle, stored } = setup({
      instances,
      onSet: () => {
        const [current] = instances;
        if (current === undefined) return;
        instances[0] = decodeProviderInstance({
          ...current,
          configuration: { ...current.configuration, baseUrl: "https://other.example/v1/" },
          version: 2,
        });
      },
    });

    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );

    expect(result).toMatchObject({ status: 409, body: { category: "changed" } });
    expect(stored.size).toBe(0);
  });

  it("clears a key it just wrote when the instance was removed during the write", async () => {
    const instances = [gateway(GATEWAY_ID, "Private gateway")];
    const { handle, stored } = setup({ instances, onSet: () => instances.splice(0) });

    const result = await json(
      await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false })),
    );

    expect(result.status).toBe(404);
    expect(stored.size).toBe(0);
  });

  it("journals a stored key and a cleared key as a request and an outcome, never the key", async () => {
    const { handle, records } = setup();
    await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false }));
    await handle(hostLocal(REMOVE, { instance: GATEWAY_ID }));

    expect(records).toEqual([
      { name: "requested", instanceId: GATEWAY_ID, action: "set", windowId },
      { name: "completed", instanceId: GATEWAY_ID, action: "set", outcome: "stored" },
      { name: "requested", instanceId: GATEWAY_ID, action: "remove", windowId },
      { name: "completed", instanceId: GATEWAY_ID, action: "remove", outcome: "removed" },
    ]);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it("journals a key cleared after the instance changed during the write", async () => {
    const instances = [gateway(GATEWAY_ID, "Private gateway")];
    const { handle, records } = setup({ instances, onSet: () => instances.splice(0) });
    await handle(hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false }));

    expect(records.at(-1)).toMatchObject({ name: "completed", outcome: "cleared-after-change" });
  });

  it("leaves a request unsettled when the store errors, and changes nothing when the request cannot be journaled", async () => {
    const failing = setup({ failDelete: true });
    await failing.handle(hostLocal(REMOVE, { instance: GATEWAY_ID }));
    // The store error may or may not have committed, so the request is left for the next start.
    expect(failing.records.map((record) => record.name)).toEqual(["requested"]);

    const unjournaled = setup({ journalFails: true });
    const result = await json(
      await unjournaled.handle(
        hostLocal(SET, { instance: GATEWAY_ID, credential: KEY, replace: false }),
      ),
    );
    expect(result).toMatchObject({ status: 503, body: { category: "journal-unavailable" } });
    expect(unjournaled.stored.size).toBe(0);
  });

  it("removes a provider and then its key, journaled as one change", async () => {
    const { handle, stored, instances, records } = setup();
    stored.set(GATEWAY_ID, KEY);

    const result = await json(
      await handle(hostLocal(REMOVE_PROVIDER, { instance: "Private gateway" })),
    );

    expect(result).toEqual({
      status: 200,
      body: { outcome: "removed", instanceId: GATEWAY_ID, displayName: "Private gateway" },
    });
    expect(instances).toHaveLength(0);
    expect(stored.has(GATEWAY_ID)).toBe(false);
    expect(records.map((record) => record.name)).toEqual(["requested", "completed"]);
    expect(records[0]).toMatchObject({ action: "remove-with-provider" });
  });

  it("keeps the key when the provider's removal is refused", async () => {
    const { handle, stored, instances, records } = setup({
      providerRefusal: "The provider has an active session.",
    });
    stored.set(GATEWAY_ID, KEY);

    const result = await json(await handle(hostLocal(REMOVE_PROVIDER, { instance: GATEWAY_ID })));

    expect(result).toMatchObject({
      status: 409,
      body: { category: "provider-refused", message: "The provider has an active session." },
    });
    expect(instances).toHaveLength(1);
    expect(stored.get(GATEWAY_ID)).toBe(KEY);
    expect(records.at(-1)).toMatchObject({ name: "failed", reason: "abandoned" });
  });

  it("clears the key when the provider service reports a failure after it already removed the provider", async () => {
    const { handle, stored, instances } = setup({
      providerRefusal: "Cleanup failed.",
      onRefuse: (list) => list.splice(0),
    });
    stored.set(GATEWAY_ID, KEY);

    const result = await json(await handle(hostLocal(REMOVE_PROVIDER, { instance: GATEWAY_ID })));

    expect(result.status).toBe(200);
    expect(instances).toHaveLength(0);
    expect(stored.has(GATEWAY_ID)).toBe(false);
  });

  it("names the removed provider when its key could not be cleared, leaving the request to settle at start", async () => {
    const { handle, instances, records } = setup({ failDelete: true });

    const result = await json(await handle(hostLocal(REMOVE_PROVIDER, { instance: GATEWAY_ID })));

    expect(result).toMatchObject({
      status: 503,
      body: { category: "provider-removed-key-kept", instanceId: GATEWAY_ID },
    });
    expect(instances).toHaveLength(0);
    expect(records.map((record) => record.name)).toEqual(["requested"]);
  });

  it("refuses to remove a provider by the same references and the same authority as key remove", async () => {
    const shared = setup({
      instances: [gateway(GATEWAY_ID, "Twin"), gateway(OTHER_ID, "Twin")],
    });
    const ambiguous = await json(
      await shared.handle(hostLocal(REMOVE_PROVIDER, { instance: "Twin" })),
    );
    expect(ambiguous).toMatchObject({ status: 409, body: { category: "ambiguous" } });
    expect(shared.instances).toHaveLength(2);

    const { handle, instances, records } = setup();
    // A removed instance's id is not a provider to remove.
    expect((await handle(hostLocal(REMOVE_PROVIDER, { instance: REMOVED_ID })))?.status).toBe(404);
    expect(
      (await handle(hostLocal(REMOVE_PROVIDER, { instance: "No such provider" })))?.status,
    ).toBe(404);

    const unavailable = setup({ storeAvailable: false });
    expect(
      (await unavailable.handle(hostLocal(REMOVE_PROVIDER, { instance: GATEWAY_ID })))?.status,
    ).toBe(503);
    expect(unavailable.instances).toHaveLength(1);

    const browser = await handle(
      hostLocal(
        REMOVE_PROVIDER,
        { instance: GATEWAY_ID },
        {
          headers: { "x-octant-desktop-secret": "", origin: "http://127.0.0.1:3773" },
        },
      ),
    );
    expect(browser?.status).toBe(401);
    const remote = await handle(
      hostLocal(REMOVE_PROVIDER, { instance: GATEWAY_ID }, { host: "100.64.0.9:3773" }),
    );
    expect(remote?.status).toBe(401);
    const noCapability = await handle(
      hostLocal(
        REMOVE_PROVIDER,
        { instance: GATEWAY_ID },
        {
          headers: { "x-octant-window-capability": "B".repeat(43) },
        },
      ),
    );
    expect(noCapability?.status).toBe(401);
    expect(instances).toHaveLength(1);
    expect(records).toEqual([]);
  });
});

describe("host-local provider key pool routes", () => {
  const keys = (path: string, body: unknown) =>
    hostLocal(`/api/desktop/provider-credentials/keys/${path}`, body);

  it("adds, renames, reorders, activates and removes keys, answering labels only", async () => {
    const { handle, stored, records } = setup();
    const first = await handle(keys("add", { instance: GATEWAY_ID, credential: KEY }));
    expect(first?.status).toBe(200);
    const added = (await first?.json()) as { key: { id: string; label: string; active: boolean } };
    expect(added.key).toMatchObject({ label: "Key 1", active: true });
    expect(JSON.stringify(added)).not.toContain(KEY);
    const second = (await (
      await handle(keys("add", { instance: GATEWAY_ID, credential: `${KEY}-2`, label: "Backup" }))
    )?.json()) as { key: { id: string } };
    for (const [path, body] of [
      ["rename", { instance: GATEWAY_ID, keyId: added.key.id, label: "Primary" }],
      ["move", { instance: GATEWAY_ID, keyId: second.key.id, direction: "up" }],
      ["set-active", { instance: GATEWAY_ID, keyId: added.key.id }],
      ["replace", { instance: GATEWAY_ID, keyId: second.key.id, credential: `${KEY}-3` }],
    ] as const) {
      const response = await handle(keys(path, body));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ outcome: "changed" });
    }
    const list = (await (await handle(keys("list", { instance: GATEWAY_ID })))?.json()) as {
      keys: Array<{ id: string; label: string; active: boolean }>;
    };
    expect(list.keys.map(({ label, active }) => ({ label, active }))).toEqual([
      { label: "Backup", active: false },
      { label: "Primary", active: true },
    ]);
    expect(stored.get(GATEWAY_ID)).toContain(`${KEY}-3`);
    for (const key of list.keys)
      await handle(keys("remove", { instance: GATEWAY_ID, keyId: key.id }));
    expect(stored.has(GATEWAY_ID)).toBe(false);
    // Each write is journaled before the store is touched, the last as a removal.
    expect(records.filter((record) => record.name === "requested")).toHaveLength(8);
    expect(records.at(-2)).toMatchObject({ name: "requested", action: "remove" });
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it("answers the pool's own refusal for a key that is no longer stored", async () => {
    const { handle } = setup();
    const response = await handle(
      keys("rename", { instance: GATEWAY_ID, keyId: "default", label: "Work" }),
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      category: "api-key-pool",
      reason: "unknown-key",
      message: "That API key is no longer stored.",
    });
  });

  it("never replaces or clears a key that points into a linked secret store", async () => {
    const { handle, stored, records, reads } = setup({ keyReference: { status: "linked" } });
    stored.set(GATEWAY_ID, "linked-pointer");
    for (const request of [
      keys("add", { instance: GATEWAY_ID, credential: KEY }),
      keys("remove", { instance: GATEWAY_ID, keyId: "default" }),
      hostLocal("/api/desktop/provider-credentials/set", {
        instance: GATEWAY_ID,
        credential: KEY,
        replace: true,
      }),
      hostLocal("/api/desktop/provider-credentials/remove", { instance: GATEWAY_ID }),
    ]) {
      const response = await handle(request);
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({ category: "linked-secret" });
    }
    expect(await (await handle(keys("list", { instance: GATEWAY_ID })))?.json()).toEqual({
      keys: [],
    });
    expect(stored.get(GATEWAY_ID)).toBe("linked-pointer");
    expect(records).toEqual([]);
    // The linked item itself is never read, so no unlock prompt is raised.
    expect(reads).toEqual([]);
  });

  it("changes nothing when the change cannot be journaled, and passes on the keyring's reason", async () => {
    const unjournaled = setup({ journalFails: true });
    expect(
      (await unjournaled.handle(keys("add", { instance: GATEWAY_ID, credential: KEY })))?.status,
    ).toBe(503);
    expect(unjournaled.stored.size).toBe(0);
    const locked = setup({ failingStore: true, failingCause: "locked" });
    const response = await locked.handle(keys("list", { instance: GATEWAY_ID }));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      category: "credential-store-unavailable",
      cause: "locked",
    });
  });

  it("passes on the keyring's reason when the key's link cannot be read", async () => {
    for (const keyReference of [
      { status: "unavailable", cause: "locked" } as const,
      { rejects: { category: "unavailable", cause: "locked" } },
    ]) {
      const { handle, records } = setup({ keyReference });
      for (const request of [
        keys("list", { instance: GATEWAY_ID }),
        keys("add", { instance: GATEWAY_ID, credential: KEY }),
        hostLocal("/api/desktop/provider-credentials/set", {
          instance: GATEWAY_ID,
          credential: KEY,
          replace: true,
        }),
      ]) {
        const response = await handle(request);
        expect(response?.status).toBe(503);
        expect(await response?.json()).toMatchObject({
          category: "credential-store-unavailable",
          cause: "locked",
        });
      }
      expect(records).toEqual([]);
    }
  });

  it("refuses a key over the broker's bound as too large, as set does", async () => {
    const { handle, stored } = setup();
    const large = "k".repeat(12 * 1_024 + 1);
    for (const request of [
      keys("add", { instance: GATEWAY_ID, credential: large }),
      keys("replace", { instance: GATEWAY_ID, keyId: "default", credential: large }),
    ]) {
      const response = await handle(request);
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ category: "too-large" });
    }
    expect(stored.size).toBe(0);
  });

  it("refuses a malformed request, an unknown provider and one without a stored key", async () => {
    const { handle } = setup({
      instances: [gateway(GATEWAY_ID, "Private gateway"), gateway(OTHER_ID, "Open", "none")],
    });
    for (const [request, status] of [
      [keys("add", { instance: GATEWAY_ID, credential: KEY, extra: true }), 400],
      [keys("move", { instance: GATEWAY_ID, keyId: "default", direction: "left" }), 400],
      [keys("remove", { instance: GATEWAY_ID, keyId: "not-a-key" }), 400],
      [keys("list", { instance: REMOVED_ID }), 404],
      [keys("add", { instance: OTHER_ID, credential: KEY }), 409],
    ] as const)
      expect((await handle(request))?.status).toBe(status);
  });

  it("refuses a caller without the bridge secret or a native main's window authority", async () => {
    const { handle } = setup();
    const response = await handle(
      hostLocal(
        "/api/desktop/provider-credentials/keys/list",
        { instance: GATEWAY_ID },
        { headers: { "x-octant-desktop-secret": "wrong" } },
      ),
    );
    expect(response?.status).toBe(401);
  });
});

describe("provider key routes for a paired device", () => {
  const deviceId = "73000000-0000-4000-8000-000000000060";
  const DEVICE_SET = "/api/providers/credentials/set";

  /** The request as the product dispatch hands it on: loopback-shaped, with the device bound. */
  function fromDevice(
    path: string,
    body: unknown,
    admittedBy?: "host-person" | "hub-roster",
  ): Request {
    const request = new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify(body),
    });
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: "local" as never,
        deviceId: deviceId as never,
        credentialGeneration: 1,
        origin: "https://octant.invalid",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "73000000-0000-4000-8000-000000000061" as never,
        ...(admittedBy === undefined ? {} : { admittedBy }),
      }),
      scopeId: deviceId as never,
    });
    return request;
  }

  it("stores and replaces a key from a device the host's own person paired, journaled as that device, and never answers with it", async () => {
    const { handle, stored, records } = setup();
    const first = await json(
      await handle(
        fromDevice(
          DEVICE_SET,
          { instance: GATEWAY_ID, credential: KEY, replace: false },
          "host-person",
        ),
      ),
    );
    expect(first).toEqual({
      status: 200,
      body: { outcome: "stored", instanceId: GATEWAY_ID, displayName: "Private gateway" },
    });
    expect(stored.get(GATEWAY_ID)).toBe(KEY);

    const replaced = await json(
      await handle(
        fromDevice(
          DEVICE_SET,
          { instance: GATEWAY_ID, credential: `${KEY}-next`, replace: true },
          "host-person",
        ),
      ),
    );
    expect(replaced.status).toBe(200);
    expect(stored.get(GATEWAY_ID)).toBe(`${KEY}-next`);

    expect(records[0]).toEqual({
      name: "requested",
      instanceId: GATEWAY_ID,
      action: "set",
      windowId: deviceId,
      actor: { kind: "remote-device", actorId: deviceId, deviceId },
    });
    expect(JSON.stringify([first.body, replaced.body, records])).not.toContain(KEY);
  });

  it("answers a person-paired device whether a key is stored and its pool's labels, never a key", async () => {
    const { handle } = setup();
    await handle(
      fromDevice(
        DEVICE_SET,
        { instance: GATEWAY_ID, credential: KEY, replace: false },
        "host-person",
      ),
    );
    const status = await json(
      await handle(
        fromDevice("/api/providers/credentials/status", { instance: GATEWAY_ID }, "host-person"),
      ),
    );
    const list = await json(
      await handle(
        fromDevice("/api/providers/credentials/keys/list", { instance: GATEWAY_ID }, "host-person"),
      ),
    );
    expect(status.body).toMatchObject({ outcome: "stored" });
    expect(list.status).toBe(200);
    expect(JSON.stringify([status.body, list.body])).not.toContain(KEY);
  });

  it("refuses a key from a hub-introduced device, an unproved pairing, and a caller with no paired device", async () => {
    const { handle, stored, records } = setup();
    const body = { instance: GATEWAY_ID, credential: KEY, replace: false };
    for (const request of [
      fromDevice(DEVICE_SET, body, "hub-roster"),
      fromDevice(DEVICE_SET, body),
      // A browser on the host itself, and the host-local command on the device path.
      new Request(`http://127.0.0.1${DEVICE_SET}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body: JSON.stringify(body),
      }),
      hostLocal(DEVICE_SET, body),
    ]) {
      const refused = await json(await handle(request));
      expect(refused.status).toBe(401);
    }
    expect(stored.size).toBe(0);
    expect(records).toEqual([]);
  });

  it("keeps the desktop bridge's own routes, and removing a provider with its key, away from every device", async () => {
    const { handle, stored, instances } = setup();
    const body = { instance: GATEWAY_ID, credential: KEY, replace: false };
    expect((await handle(fromDevice(SET, body, "host-person")))?.status).toBe(401);
    expect(
      await handle(
        fromDevice(
          "/api/providers/credentials/remove-provider",
          { instance: GATEWAY_ID },
          "host-person",
        ),
      ),
    ).toBeUndefined();
    expect(stored.size).toBe(0);
    expect(instances).toHaveLength(1);
  });
});
