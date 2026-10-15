import { describe, expect, it } from "vitest";
import { decodeProviderInstance, decodeWindowId, type ProviderInstance } from "@octant/contracts";
import { addApiKey } from "@octant/host-runtime";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ProviderKeyJournal } from "./providerKeyJournal";
import { createProviderCredentialRouteHandler } from "./providerCredentialRoutes";

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
    readonly onSet?: () => void;
    readonly journalFails?: boolean;
    readonly failDelete?: boolean;
    readonly providerRefusal?: string;
    readonly onRemoveProvider?: (instance: ProviderInstance) => void;
  } = {},
) {
  const records: Array<Record<string, unknown>> = [];
  const journal: ProviderKeyJournal = {
    request: (request) => {
      if (input.journalFails === true) throw new Error("journal unavailable");
      const common = { instanceId: request.instanceId, action: request.action };
      records.push({ name: "requested", ...common, windowId: request.windowId });
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
    throw { category: "unavailable", message: "The provider credential store is unavailable." };
  };
  const handle = createProviderCredentialRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    readProviderInstances: () => instances,
    readRemovedProviderInstanceIds: () => [REMOVED_ID],
    journal,
    removeProvider: async (_window, instance) => {
      if (input.providerRefusal !== undefined) {
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
            readStored: async (id) => stored.get(id) ?? "",
          },
  });
  return { handle, stored, instances, records };
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

  it("journals a failed write and changes nothing when the request cannot be journaled", async () => {
    const failing = setup({ failDelete: true });
    await failing.handle(hostLocal(REMOVE, { instance: GATEWAY_ID }));
    expect(failing.records.map((record) => record.name)).toEqual(["requested", "failed"]);

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
