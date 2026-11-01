import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeWindowId,
  type ProviderInstance,
} from "@octant/contracts";
import {
  CredentialStoreFailure,
  makeLinkedSecretStores,
  startCredentialBroker,
  type CredentialBroker,
  type CredentialStore,
  type LinkedSecretRead,
  type LinkedSecretStoreAdapter,
  type LinkedSecretToolState,
} from "@octant/host-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { redactHostSecrets } from "../process/secretRedaction";
import {
  makeCredentialBrokerClient,
  makeMcpServerCredentialBrokerClient,
} from "../providers/credentialBrokerClient";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { UserAddedMcpServerStore } from "../extensions/userAddedMcpServers";
import { awsCliEnvironment } from "./awsCliEnvironment";
import { makeConnectorLinkedSecrets } from "./connectorLinkedSecrets";
import { makeSecretStoreBrokerClient } from "./secretStoreBrokerClient";
import { secretStoresJournal } from "./secretStoresJournal";
import { createSecretStoresRouteHandler } from "./secretStoresRoutes";
import { createSecretStoresService } from "./secretStoresService";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import type { WindowAuthorityStore } from "../windowAuthorityStore";

const NOW = "2026-10-31T10:00:00.000Z";
const VALUE = "linked-value-that-must-stay-out-of-the-journal-4a61";
const REFERENCE = "op://Private/Gateway key/credential";
const GATEWAY_ID = "80000000-0000-4000-8000-000000000501";
const WINDOW = decodeWindowId("33333333-3333-4333-8333-333333333333");
const instanceId = decodeProviderInstanceId(GATEWAY_ID);

const directories: string[] = [];
const brokers: CredentialBroker[] = [];
const connections: SqliteConnection[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gateway(authentication: "bearer" | "none" = "bearer"): ProviderInstance {
  return decodeProviderInstance({
    id: GATEWAY_ID,
    displayName: "Private gateway",
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
    createdAt: NOW,
    updatedAt: NOW,
  });
}

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

/** A secret store tool the test controls: its lock, its items, and its calls. */
function fakeTool() {
  const state = {
    tool: "ready" as LinkedSecretToolState,
    items: new Map<string, string>(),
    /** Runs while the broker reads an item, to change the world mid-check. */
    onRead: undefined as (() => void) | undefined,
  };
  const adapter: LinkedSecretStoreAdapter = {
    kind: "onepassword",
    label: "1Password",
    isValidReference: (reference) => reference.startsWith("op://"),
    probe: async () => state.tool,
    read: async (reference): Promise<LinkedSecretRead> => {
      state.onRead?.();
      if (state.tool === "locked") return { status: "locked" };
      const value = state.items.get(reference);
      return value === undefined ? { status: "missing" } : { status: "read", value };
    },
  };
  return { state, adapter };
}

async function host(
  options: { readonly journalFails?: boolean; readonly noBroker?: boolean } = {},
) {
  const tool = fakeTool();
  tool.state.items.set(REFERENCE, VALUE);
  tool.state.items.set(AWS_KEY_ID_REFERENCE, AWS_LONG_LIVED_KEY_ID);
  tool.state.items.set(AWS_SECRET_REFERENCE, AWS_LONG_LIVED_SECRET);
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), "octant-secret-stores-"));
  directories.push(directory);
  const broker = await startCredentialBroker(
    store,
    undefined,
    { fetch: fakeSts },
    undefined,
    undefined,
    undefined,
    memoryStore(),
    undefined,
    undefined,
    makeLinkedSecretStores({
      statePath: join(directory, "linked.json"),
      adapters: [tool.adapter],
    }),
  );
  brokers.push(broker);

  const connection = openSqlite(join(directory, "events.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => NOW,
  });
  const real = secretStoresJournal({
    journal,
    connection,
    uuid: () => crypto.randomUUID(),
    now: () => NOW,
  });
  const failing = {
    journalFails: options.journalFails ?? false,
    /** Runs when the journal refuses, before it throws. */
    onRefuse: undefined as (() => void) | undefined,
  };
  const reprobes: string[] = [];
  const instances = [
    gateway(),
    decodeProviderInstance({ ...gateway("none"), id: "80000000-0000-4000-8000-000000000502" }),
  ];
  const service = createSecretStoresService({
    broker:
      options.noBroker === true
        ? undefined
        : makeSecretStoreBrokerClient({ url: broker.url, token: broker.token }),
    journal: {
      record: (record) => {
        if (failing.journalFails) {
          failing.onRefuse?.();
          throw new Error("journal down");
        }
        real.record(record);
      },
    },
    readProviderInstances: () => instances,
    reprobe: async (_window, instance) => void reprobes.push(String(instance.id)),
  });
  const resolveKey = () =>
    makeCredentialBrokerClient({ url: broker.url, token: broker.token }).resolve(GATEWAY_ID);
  const journalText = () =>
    JSON.stringify(
      connection.prepare("SELECT payload_json FROM event_journal").all() as ReadonlyArray<unknown>,
    );
  const journalNames = () =>
    (
      connection
        .prepare(
          "SELECT payload_json FROM event_journal WHERE event_name = 'secret-store.recorded@1'",
        )
        .all() as ReadonlyArray<{ payload_json: string }>
    ).map((row) => (JSON.parse(row.payload_json) as { name: string }).name);
  const connectorServers = () => {
    const registry = new LocalPluginFolderRegistry({ sourceKind: "user-added" });
    const clientOptions = { url: broker.url, token: broker.token };
    const servers = new UserAddedMcpServerStore({
      directory: join(directory, "user-added"),
      registry,
      secrets: makeMcpServerCredentialBrokerClient(clientOptions),
      linkedSecrets: makeConnectorLinkedSecrets({
        broker: makeSecretStoreBrokerClient(clientOptions),
        journal: {
          record: (record) => {
            if (failing.journalFails) throw new Error("journal down");
            real.record(record);
          },
        },
      }),
    });
    return { servers, registry };
  };
  return {
    tool,
    directory,
    instances,
    store,
    broker,
    service,
    failing,
    resolveKey,
    journalText,
    journalNames,
    reprobes,
    connectorServers,
  };
}

const AWS_KEY_ID_REFERENCE = "op://Private/AWS/access key id";
const AWS_SECRET_REFERENCE = "op://Private/AWS/secret access key";
const AWS_LONG_LIVED_KEY_ID = "AKIAFIXTURE0000LONG";
const AWS_LONG_LIVED_SECRET = "fixtureLongLivedSecret/0123456789abcdefghij";
const AWS_SESSION_SECRET = "fixtureSessionSecret/abcdefghij0123456789";
const AWS_SESSION_TOKEN = "FwoGZXIvYXdzEFixtureSessionToken0123456789";
const awsPointer = {
  store: "onepassword",
  accessKeyIdReference: AWS_KEY_ID_REFERENCE,
  secretAccessKeyReference: AWS_SECRET_REFERENCE,
} as const;

/** AWS STS as the broker meets it: a one-hour session for any signed request. */
const fakeSts = Object.assign(
  async (): Promise<Response> =>
    new Response(
      `<GetSessionTokenResponse><GetSessionTokenResult><Credentials>
      <AccessKeyId>ASIAFIXTURE00SESSION</AccessKeyId>
      <SecretAccessKey>${AWS_SESSION_SECRET}</SecretAccessKey>
      <SessionToken>${AWS_SESSION_TOKEN}</SessionToken>
      <Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration>
    </Credentials></GetSessionTokenResult></GetSessionTokenResponse>`,
    ),
  { preconnect: fetch.preconnect },
);

describe("the AWS command line through a linked store", () => {
  it("points at two items, journals both halves as one change, and gives a command only a session", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");

    expect(await h.service.pointAwsCliKey(WINDOW, awsPointer)).toEqual({
      kind: "secret-stores-aws-cli-key",
      reference: awsPointer,
    });
    expect(await h.service.readAwsCliKey()).toEqual({
      kind: "secret-stores-aws-cli-key",
      reference: awsPointer,
    });
    expect(h.journalNames()).toEqual([
      "secret-store.linked",
      "credential-reference.set",
      "credential-reference.set",
    ]);
    expect(h.journalText()).toContain(AWS_SECRET_REFERENCE);

    const environment = await awsCliEnvironment(
      makeSecretStoreBrokerClient({ url: h.broker.url, token: h.broker.token }),
    );
    expect(environment).toMatchObject({
      AWS_ACCESS_KEY_ID: "ASIAFIXTURE00SESSION",
      AWS_SECRET_ACCESS_KEY: AWS_SESSION_SECRET,
      AWS_SESSION_TOKEN: AWS_SESSION_TOKEN,
    });
    expect(JSON.stringify(environment)).not.toContain(AWS_LONG_LIVED_SECRET);
    expect(h.journalText()).not.toContain(AWS_LONG_LIVED_SECRET);
    // A command that prints the session has it redacted wherever its output is kept.
    expect(redactHostSecrets(`secret=${AWS_SESSION_SECRET}`)).not.toContain(AWS_SESSION_SECRET);
  });

  it("refuses an item that does not resolve, and gives a command nothing without a pointer", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    const client = makeSecretStoreBrokerClient({ url: h.broker.url, token: h.broker.token });

    expect(
      await h.service.pointAwsCliKey(WINDOW, {
        ...awsPointer,
        secretAccessKeyReference: "op://Private/AWS/gone",
      }),
    ).toMatchObject({ kind: "secret-stores-refused", reason: "item-missing" });
    await expect(awsCliEnvironment(client)).resolves.toEqual({});
    await expect(awsCliEnvironment(undefined)).resolves.toEqual({});
    // A broker that never answers does not hold the command.
    await expect(
      awsCliEnvironment({ awsCliSession: () => new Promise(() => {}) }, 10),
    ).resolves.toEqual({});
  });

  it("undoes a pointer the journal refused, and journals a clear with both items", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");

    h.failing.journalFails = true;
    expect(await h.service.pointAwsCliKey(WINDOW, awsPointer)).toMatchObject({
      reason: "journal-unavailable",
    });
    expect(await h.service.readAwsCliKey()).toEqual({
      kind: "secret-stores-aws-cli-key",
      reference: null,
    });

    h.failing.journalFails = false;
    await h.service.pointAwsCliKey(WINDOW, awsPointer);
    expect(await h.service.clearAwsCliKey(WINDOW)).toEqual({
      kind: "secret-stores-aws-cli-key",
      reference: null,
    });
    expect(h.journalNames().slice(-2)).toEqual([
      "credential-reference.cleared",
      "credential-reference.cleared",
    ]);
  });
});

describe("linked secret stores through the host", () => {
  it("links a store, points a provider key at an item, and gives the provider the value at use", async () => {
    const h = await host();
    expect((await h.service.linkStore(WINDOW, "onepassword")).kind).toBe("secret-stores-view");
    const pointed = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(pointed).toEqual({
      kind: "secret-stores-provider-reference",
      instanceId,
      reference: { store: "onepassword", reference: REFERENCE },
    });

    // The provider's existing path asks the broker, which fetches the value now.
    await expect(h.resolveKey()).resolves.toBe(VALUE);
    expect(h.reprobes).toEqual([GATEWAY_ID]);
    expect([...h.store.entries.values()].join("\n")).not.toContain(VALUE);
    expect(h.journalNames()).toEqual(["secret-store.linked", "credential-reference.set"]);
    expect(h.journalText()).toContain(REFERENCE);
    expect(h.journalText()).not.toContain(VALUE);
  });

  it("reports a locked store plainly, and the provider's key read fails closed with the same words", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });

    h.tool.state.tool = "locked";
    await expect(h.resolveKey()).rejects.toMatchObject({
      category: "unavailable",
      message: expect.stringContaining("locked"),
    });
    expect(await h.service.checkReference("onepassword", REFERENCE)).toEqual({
      kind: "secret-stores-checked",
      store: "onepassword",
      outcome: "locked",
    });
    const refused = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(refused).toMatchObject({ kind: "secret-stores-refused", reason: "store-locked" });
    expect(await h.service.linkStore(WINDOW, "onepassword")).toMatchObject({
      reason: "store-locked",
    });
  });

  it("reports a missing item and refuses to point at it", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    const refused = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: "op://Private/Absent/credential",
    });
    expect(refused).toMatchObject({ reason: "item-missing" });
    expect(h.store.entries.size).toBe(0);

    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    h.tool.state.items.delete(REFERENCE);
    await expect(h.resolveKey()).rejects.toMatchObject({
      category: "unauthenticated",
      message: expect.stringContaining("not found"),
    });
  });

  it("fails closed after the store is unlinked and journals the unlink", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    await h.service.unlinkStore(WINDOW, "onepassword");
    await expect(h.resolveKey()).rejects.toMatchObject({
      message: expect.stringContaining("no longer linked"),
    });
    expect(h.journalNames().at(-1)).toBe("secret-store.unlinked");
  });

  it("journals clearing a reference with what it pointed at, and nothing else", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(await h.service.clearProviderKeyReference(WINDOW, instanceId)).toEqual({
      kind: "secret-stores-provider-reference",
      instanceId,
      reference: null,
    });
    expect(h.store.entries.size).toBe(0);
    expect(h.journalNames().at(-1)).toBe("credential-reference.cleared");
    expect(h.journalText()).not.toContain(VALUE);
    // Clearing again changes and records nothing.
    const before = h.journalNames().length;
    await h.service.clearProviderKeyReference(WINDOW, instanceId);
    expect(h.journalNames()).toHaveLength(before);
  });

  it("marks a replaced reference, and undoes a change the journal refused", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    h.tool.state.items.set("op://Private/Second/credential", "second");
    h.failing.journalFails = true;
    const refused = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: "op://Private/Second/credential",
    });
    expect(refused).toMatchObject({ reason: "journal-unavailable" });
    await expect(h.resolveKey()).resolves.toBe(VALUE);

    h.failing.journalFails = false;
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: "op://Private/Second/credential",
    });
    expect(h.journalText()).toContain('\\"replaced\\":true');

    // A first link the journal refuses leaves nothing linked.
    const second = await host({ journalFails: true });
    expect(await second.service.linkStore(WINDOW, "onepassword")).toMatchObject({
      reason: "journal-unavailable",
    });
    expect((await second.service.view()).kind).toBe("secret-stores-view");
    expect(await second.service.view()).toMatchObject({ stores: [{ linked: false }] });
  });

  it("deletes the pointer and refuses when the provider is removed or reconfigured while the item is checked", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");

    // Reconfigured meanwhile: the old endpoint's key must not reach the new one.
    h.tool.state.onRead = () => {
      h.instances[0] = decodeProviderInstance({ ...gateway(), version: 2 });
    };
    const changed = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(changed).toMatchObject({ kind: "secret-stores-refused", reason: "provider-changed" });
    expect(h.store.entries.has(GATEWAY_ID)).toBe(false);
    expect(h.journalNames()).toEqual(["secret-store.linked"]);

    // Removed meanwhile: a delayed write must not recreate the credential.
    h.instances[0] = gateway();
    h.tool.state.onRead = () => {
      h.instances.splice(0, 1);
    };
    const removed = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(removed).toMatchObject({ kind: "secret-stores-refused" });
    expect(h.store.entries.has(GATEWAY_ID)).toBe(false);
    expect(h.reprobes).toEqual([]);
  });

  it("fails closed when the journal refuses and the earlier item can no longer be read to restore it", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    h.tool.state.items.set("op://Private/Second/credential", "second");
    h.failing.journalFails = true;
    // By the time the journal refuses, the earlier item is gone and the store is locked.
    h.failing.onRefuse = () => {
      h.tool.state.items.delete(REFERENCE);
      h.tool.state.tool = "locked";
    };
    const refused = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: "op://Private/Second/credential",
    });
    expect(refused).toMatchObject({ kind: "secret-stores-refused", reason: "journal-unavailable" });
    // The earlier pointer is put back without reading its item, so the new,
    // unjournaled one is not left active.
    expect(h.store.entries.get(GATEWAY_ID)).toContain(REFERENCE);
    expect(h.store.entries.get(GATEWAY_ID)).not.toContain("Second");
  });

  it("clears the pointer and says so when the earlier one cannot be restored either", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    h.tool.state.items.set("op://Private/Second/credential", "second");
    h.failing.journalFails = true;
    // The store is unlinked as the journal refuses, so putting the earlier pointer back is refused.
    h.failing.onRefuse = () => writeFileSync(join(h.directory, "linked.json"), '{"stores":{}}');
    const refused = await h.service.pointProviderKey(WINDOW, {
      instanceId,
      store: "onepassword",
      reference: "op://Private/Second/credential",
    });
    expect(refused).toMatchObject({ kind: "secret-stores-refused", reason: "journal-unavailable" });
    expect(refused).toMatchObject({ message: expect.stringContaining("removed") });
    expect(h.store.entries.has(GATEWAY_ID)).toBe(false);
  });

  it("never replaces a key the person stored, and refuses a provider without a stored key", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    h.store.entries.set(GATEWAY_ID, "sk-pasted-by-person");
    expect(
      await h.service.pointProviderKey(WINDOW, {
        instanceId,
        store: "onepassword",
        reference: REFERENCE,
      }),
    ).toMatchObject({ reason: "key-already-stored" });
    expect(h.store.entries.get(GATEWAY_ID)).toBe("sk-pasted-by-person");

    expect(
      await h.service.pointProviderKey(WINDOW, {
        instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000502"),
        store: "onepassword",
        reference: REFERENCE,
      }),
    ).toMatchObject({ reason: "no-stored-key-authentication" });
    expect(
      await h.service.pointProviderKey(WINDOW, {
        instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000999"),
        store: "onepassword",
        reference: REFERENCE,
      }),
    ).toMatchObject({ reason: "unknown-provider" });
  });

  it("says plainly that a host with no credential broker cannot link a store", async () => {
    const h = await host({ noBroker: true });
    expect(await h.service.view()).toEqual({
      kind: "secret-stores-view",
      brokerAvailable: false,
      stores: [],
    });
    expect(await h.service.linkStore(WINDOW, "onepassword")).toMatchObject({
      reason: "broker-unavailable",
    });
  });

  it("keeps the value out of every answer, journal row, and log line across the whole flow", async () => {
    const h = await host();
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const answers: unknown[] = [
      await h.service.view(),
      await h.service.linkStore(WINDOW, "onepassword"),
      await h.service.checkReference("onepassword", REFERENCE),
      await h.service.pointProviderKey(WINDOW, {
        instanceId,
        store: "onepassword",
        reference: REFERENCE,
      }),
      await h.service.readProviderKeyReference(instanceId),
    ];
    h.tool.state.tool = "locked";
    await h.resolveKey().catch((error: unknown) => answers.push(error));
    h.tool.state.tool = "ready";
    answers.push(await h.service.clearProviderKeyReference(WINDOW, instanceId));
    answers.push(await h.service.unlinkStore(WINDOW, "onepassword"));

    expect(JSON.stringify(answers)).not.toContain(VALUE);
    expect(logged.join("\n")).not.toContain(VALUE);
    expect(h.journalText()).not.toContain(VALUE);
  });
});

describe("an MCP server's secret that comes from a linked store", () => {
  const request = (linked: { store: "onepassword"; reference: string }) => ({
    name: "Docs search",
    server: {
      type: "stdio" as const,
      command: "npx",
      args: ["docs-search-mcp"],
      env: [{ name: "DOCS_TOKEN", value: "", secret: true, linked }],
    },
  });

  it("keeps only a pointer, fetches the value at launch, and journals the reference", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    const { servers, registry } = h.connectorServers();
    const { source } = await servers.add(request({ store: "onepassword", reference: REFERENCE }));

    // The package on disk names its secret by id and holds no value.
    const folder = registry.get(source.sourceRef)?.absolutePath ?? "";
    const mcpJson = await readFile(join(folder, "mcp.json"), "utf8");
    expect(mcpJson).not.toContain(VALUE);
    const reference = /\$\{OCTANT_SECRET:[0-9a-f-]{36}\}/.exec(mcpJson)?.[0] ?? "";
    expect(reference).not.toBe("");
    // Launching asks the broker, which follows the pointer to the item.
    const launch = await servers.resolveLaunchSecrets({
      transport: "stdio",
      command: "npx",
      args: [],
      env: { DOCS_TOKEN: reference },
    } as never);
    expect(launch).toMatchObject({ env: { DOCS_TOKEN: VALUE } });
    expect(h.journalNames()).toContain("credential-reference.set");
    expect(h.journalText()).toContain("connector-secret");
    expect(h.journalText()).not.toContain(VALUE);

    await servers.remove(source.sourceRef);
    expect(h.journalNames().at(-1)).toBe("credential-reference.cleared");
  });

  it("refuses to add the server when the store is locked or the item is missing, keeping nothing", async () => {
    const h = await host();
    await h.service.linkStore(WINDOW, "onepassword");
    const { servers } = h.connectorServers();
    await expect(
      servers.add(request({ store: "onepassword", reference: "op://Private/Absent/credential" })),
    ).rejects.toThrow("No item with that reference was found in the secret store.");
    h.tool.state.tool = "locked";
    await expect(
      servers.add(request({ store: "onepassword", reference: REFERENCE })),
    ).rejects.toThrow("The secret store is locked. Unlock it, then try again.");
    expect(h.journalNames()).toEqual(["secret-store.linked"]);
  });
});

describe("secret store routes", () => {
  function route() {
    const service = {
      view: vi.fn(async () => ({
        kind: "secret-stores-view" as const,
        brokerAvailable: true,
        stores: [],
      })),
      linkStore: vi.fn(),
      unlinkStore: vi.fn(),
      checkReference: vi.fn(),
      pointProviderKey: vi.fn(),
      clearProviderKeyReference: vi.fn(),
      readProviderKeyReference: vi.fn(),
      pointAwsCliKey: vi.fn(),
      clearAwsCliKey: vi.fn(),
      readAwsCliKey: vi.fn(),
    };
    const handler = createSecretStoresRouteHandler({
      service,
      windowAuthorityStore: {
        authenticate: vi.fn(() => WINDOW),
      } as unknown as WindowAuthorityStore,
    });
    return { service, handler };
  }
  const post = (body: unknown, host = "127.0.0.1:13773") =>
    new Request(`http://${host}/api/secret-stores/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-octant-window-capability": "capability" },
      body: JSON.stringify(body),
    });
  const asLocalWindow = (request: Request): Request => {
    bindPrincipalRouteContext(request, {
      principal: { kind: "local-window", windowId: WINDOW, capabilityGeneration: 1 },
      scopeId: WINDOW,
    });
    return request;
  };

  it("serves a local window and refuses a paired device, a non-loopback host, and an unknown command", async () => {
    const { handler, service } = route();
    const ok = await handler(
      asLocalWindow(
        new Request("http://127.0.0.1:13773/api/secret-stores/settings", {
          headers: { "x-octant-window-capability": "capability" },
        }),
      ),
    );
    expect(ok?.status).toBe(200);
    expect(service.view).toHaveBeenCalledOnce();

    const device = post({ kind: "unlink-store", store: "onepassword" });
    bindPrincipalRouteContext(device, {
      principal: {
        kind: "remote-device",
        deviceId: "device" as never,
        sessionId: "session" as never,
        hostId: "host" as never,
      } as never,
      scopeId: WINDOW,
    });
    expect((await handler(device))?.status).toBe(403);
    expect(service.unlinkStore).not.toHaveBeenCalled();

    expect(
      (
        await handler(
          asLocalWindow(post({ kind: "unlink-store", store: "onepassword" }, "192.168.1.5:13773")),
        )
      )?.status,
    ).toBe(400);
    const malformed = await handler(
      asLocalWindow(post({ kind: "reveal-value", store: "onepassword" })),
    );
    expect(await malformed?.json()).toMatchObject({
      kind: "secret-stores-refused",
      reason: "malformed",
    });
    const extra = await handler(
      asLocalWindow(
        post({ kind: "check-reference", store: "onepassword", reference: REFERENCE, value: "x" }),
      ),
    );
    expect(await extra?.json()).toMatchObject({ reason: "malformed" });
  });

  it("does not answer a path that is not its own", async () => {
    const { handler } = route();
    expect(await handler(new Request("http://127.0.0.1:13773/api/replica-store/commands"))).toBe(
      undefined,
    );
  });
});
