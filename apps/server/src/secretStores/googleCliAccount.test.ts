import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Server } from "node:http";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import { decodeWindowId } from "@octant/contracts";
import {
  CredentialStoreFailure,
  makeLinkedSecretStores,
  startCredentialBroker,
  type CredentialBroker,
  type CredentialStore,
} from "@octant/host-runtime";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  buildDenyDefaultSeatbeltProfile,
  seatbeltAllowRule,
  seatbeltDenyRule,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import { buildBubblewrapLaunch } from "../process/linuxConfinement";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createGoogleCliCommandCredentials } from "./googleCliCommandCredentials";
import { secretStoresJournal } from "./secretStoresJournal";
import { makeSecretStoreBrokerClient } from "./secretStoreBrokerClient";
import { createSecretStoresService } from "./secretStoresService";
import { createSecretStoresRouteHandler } from "./secretStoresRoutes";
import { bindPrincipalRouteContext, resolvePrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore, WINDOW_AUTHORITY_TTL_MS } from "../windowAuthorityStore";
import { configureSecretGuardLocations } from "../process/secretGuard";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const selected = {
  store: "onepassword" as const,
  reference: "op://Private/Cloud account/credential",
  serviceAccountEmail: "commands@example.iam.gserviceaccount.com",
  scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
};
const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const material = JSON.stringify({
  type: "service_account",
  client_email: selected.serviceAccountEmail,
  private_key: privateKey,
});
const owned: { directory: string; broker: CredentialBroker; connection: SqliteConnection }[] = [];
beforeEach(() => {
  // Only listener startup is substituted; authenticated broker routes and storage are real.
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
    queueMicrotask(() => this.emit("listening"));
    return this;
  });
  vi.spyOn(Server.prototype, "address").mockReturnValue({
    address: "127.0.0.1",
    family: "IPv4",
    port: 13773,
  });
});
afterEach(async () => {
  try {
    for (const item of owned.splice(0)) {
      try {
        await item.broker.close();
      } finally {
        item.connection.close();
        await rm(item.directory, { recursive: true, force: true });
      }
    }
  } finally {
    vi.restoreAllMocks();
    const { realpath } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.realpath).mockReset().mockImplementation(realpath);
  }
});
function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octant-google-account-"));
  configureSecretGuardLocations({ dataDirectory: directory });
  const linked = makeLinkedSecretStores({
    statePath: join(directory, "linked.json"),
    adapters: [
      {
        kind: "onepassword",
        label: "Fixture store",
        probe: async () => "ready",
        isValidReference: (value) => value.startsWith("op://"),
        read: async (reference) =>
          reference === selected.reference
            ? { status: "read", value: material }
            : { status: "missing" },
      },
    ],
  });
  await linked.link("onepassword");
  const clock = { now: Date.parse("2026-11-02T23:00:00.000Z") };
  const broker = await startCredentialBroker(
    memoryStore(),
    undefined,
    {
      now: () => clock.now,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          access_token: "fixture-issued-short-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      ),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    linked,
  );
  const client = makeSecretStoreBrokerClient({
    url: broker.url,
    token: broker.token,
    fetch: vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => broker.fetchForTest(new Request(input, init))),
  });
  const connection = openSqlite(join(directory, "journal.sqlite3"));
  owned.push({ directory, broker, connection });
  applyMigrations(connection, MIGRATIONS, () => new Date(clock.now).toISOString());
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(clock.now).toISOString(),
  });
  const audit = secretStoresJournal({
    journal,
    connection,
    uuid: randomUUID,
    now: () => new Date(clock.now).toISOString(),
  });
  let refuseJournal: "all" | "committed" | undefined;
  const scriptRoot = join(directory, "harness", "scripts");
  await mkdir(scriptRoot, { recursive: true });
  const commands = createGoogleCliCommandCredentials({
    broker: client,
    configurationRoot: join(directory, "harness", "cloud-cli"),
    scriptRoot,
    now: () => clock.now,
  });
  await commands.recover(async () => {});
  const service = createSecretStoresService({
    beginGoogleCliChange: commands.beginChange,
    broker: client,
    journal: {
      record: (record) => {
        if (
          refuseJournal === "all" ||
          (refuseJournal === "committed" &&
            "name" in record &&
            record.name === "credential-reference.set")
        )
          throw new Error("Journal unavailable");
        audit.record(record);
      },
    },
    readProviderInstances: () => [],
  });
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: clock.now });
  const route = createSecretStoresRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => clock.now,
  });
  const request = (command: unknown) =>
    new Request("http://127.0.0.1/api/secret-stores/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "x-octant-window-capability": capability },
      body: JSON.stringify(command),
    });
  const dispatch = (request: Request) => {
    bindPrincipalRouteContext(
      request,
      resolvePrincipalRouteContext({ request, store, now: clock.now }),
    );
    return route(request);
  };
  return {
    client,
    service,
    commands,
    directory,
    scriptRoot,
    store,
    clock,
    dispatch,
    request,
    journalText: () =>
      JSON.stringify(connection.prepare("SELECT payload_json FROM event_journal").all()),
    failJournal: (stage: "all" | "committed" = "all") => {
      refuseJournal = stage;
    },
  };
}
const command = {
  kind: "point-google-cli-account" as const,
  confirmed: true as const,
  ...selected,
};
describe("person-selected Google command-line account through actual host routes", () => {
  it("refuses malformed broker timestamps instead of exposing a public report or token with a guessed expiry", async () => {
    const reference = makeSecretStoreBrokerClient({
      url: "http://127.0.0.1:13773",
      token: "fixture-only-broker-token",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ status: "linked", ...selected, sessionExpiresAt: "November 3, 2026" }),
        ),
    });
    expect(await reference.googleCliReference?.()).toEqual({ status: "broker-unavailable" });
    const session = makeSecretStoreBrokerClient({
      url: "http://127.0.0.1:13773",
      token: "fixture-only-broker-token",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status: "issued",
          accessToken: "fixture-short-token",
          expiration: "November 3, 2026",
          serviceAccountEmail: selected.serviceAccountEmail,
          scopes: selected.scopes,
        }),
      ),
    });
    expect(await session.googleCliSession?.()).toEqual({ status: "broker-unavailable" });
  });
  it.each(["darwin", "linux"] as const)(
    "isolates sibling tokens in the actual %s confinement policy, not just the positive grant",
    async (platform) => {
      const f = await fixture();
      await f.service.pointGoogleCliAccount(windowId, selected);
      const project = join(f.directory, "project");
      const temporary = join(f.directory, "temporary");
      await mkdir(project);
      await mkdir(temporary);
      const commandDirectory = await fsPromises.mkdtemp(join(f.scriptRoot, "octant-harness-"));
      const script = join(commandDirectory, "command.sh");
      await writeFile(script, "gcloud projects list\n");
      const entry = await f.commands.prepare(commandDirectory);
      if (entry?.status !== "ready" || entry.configurationDirectory === undefined)
        throw new Error("Google resource missing");
      const confinement = vi.fn<ProcessConfinementPort["prepare"]>(() => ({
        command: process.execPath,
        args: [],
      }));
      const spawn = vi.fn(() => {
        throw new Error("Sentinel spawn; no native process is launched");
      });
      const port = new RepositoryTestProcessPort({
        platform,
        temporaryDirectory: temporary,
        harnessShellScriptDirectory: f.scriptRoot,
        confinement: { prepare: confinement },
        spawn,
      });
      try {
        await port.executeShellScript({
          script,
          cwd: project,
          environment: entry.environment,
          cloudCliConfigurationDirectory: entry.configurationDirectory,
          beforeLaunch: entry.beforeLaunch,
          timeoutMs: 1000,
        });
        expect(spawn).toHaveBeenCalledOnce();
        const input = confinement.mock.calls[0]?.[0];
        if (input === undefined) throw new Error("Confinement admission missing");
        const root = join(f.directory, "harness", "cloud-cli");
        const resource = dirname(entry.configurationDirectory);
        if (platform === "darwin") {
          const profile = buildDenyDefaultSeatbeltProfile({
            ...input,
            homeDirectory: f.directory,
            usersDirectory: f.directory,
          });
          const readDeny = profile.lastIndexOf(seatbeltDenyRule("file-read*", root));
          const writeDeny = profile.lastIndexOf(seatbeltDenyRule("file-write*", root));
          expect(readDeny).toBeGreaterThan(profile.indexOf("(allow file-read*)"));
          expect(writeDeny).toBeGreaterThan(0);
          expect(profile.lastIndexOf(seatbeltAllowRule("file-read*", resource))).toBeGreaterThan(
            readDeny,
          );
          expect(
            profile.lastIndexOf(seatbeltAllowRule("file-write*", entry.configurationDirectory)),
          ).toBeGreaterThan(writeDeny);
          expect(profile).not.toContain(seatbeltAllowRule("file-write*", resource));
        } else {
          const { args } = buildBubblewrapLaunch(input, { bwrapPath: "/bin/true" });
          expect(args.join("\n")).toContain(`--tmpfs\n${root}`);
          expect(args.join("\n")).toContain(`--ro-bind\n${resource}\n${resource}`);
          expect(args.join("\n")).toContain(
            `--bind\n${entry.configurationDirectory}\n${entry.configurationDirectory}`,
          );
          expect(args.join("\n")).not.toContain(`--bind\n${root}\n${root}`);
        }
        await port.executeShellScript({
          script,
          cwd: project,
          environment: {},
          timeoutMs: 1000,
        });
        const withoutAccount = confinement.mock.calls[1]?.[0];
        if (withoutAccount === undefined) throw new Error("Unconfigured launch missing");
        expect(spawn).toHaveBeenCalledTimes(2);
        if (platform === "darwin") {
          const profile = buildDenyDefaultSeatbeltProfile({
            ...withoutAccount,
            homeDirectory: f.directory,
            usersDirectory: f.directory,
          });
          expect(profile.lastIndexOf(seatbeltDenyRule("file-read*", root))).toBeGreaterThan(
            profile.indexOf("(allow file-read*)"),
          );
          expect(profile).not.toContain(seatbeltAllowRule("file-read*", resource));
        } else {
          expect(withoutAccount.additionalDenyReadPaths).toContain(root);
          const { args } = buildBubblewrapLaunch(withoutAccount, { bwrapPath: "/bin/true" });
          expect(args.join("\n")).not.toContain(`--ro-bind\n${resource}\n${resource}`);
          expect(args.join("\n")).not.toContain(`--bind\n${root}\n${root}`);
        }
      } finally {
        await entry.close();
      }
    },
  );
  it("does not let a writable resource-root binding override command token isolation", async () => {
    const f = await fixture();
    await f.service.pointGoogleCliAccount(windowId, selected);
    const temporary = join(f.directory, "temporary");
    await mkdir(temporary);
    const commandDirectory = await fsPromises.mkdtemp(join(f.scriptRoot, "octant-harness-"));
    const script = join(commandDirectory, "command.sh");
    await writeFile(script, "gcloud projects list\n");
    const entry = await f.commands.prepare(commandDirectory);
    if (entry?.status !== "ready" || entry.configurationDirectory === undefined)
      throw new Error("Google resource missing");
    const confinement = vi.fn(() => ({ command: process.execPath, args: [] }));
    const spawn = vi.fn(() => {
      throw new Error("Writable token-root launch must not spawn");
    });
    const port = new RepositoryTestProcessPort({
      platform: "linux",
      temporaryDirectory: temporary,
      harnessShellScriptDirectory: f.scriptRoot,
      confinement: { prepare: confinement },
      spawn,
    });
    try {
      expect(
        await port.executeShellScript({
          script,
          cwd: join(f.directory, "harness", "cloud-cli"),
          environment: entry.environment,
          cloudCliConfigurationDirectory: entry.configurationDirectory,
          beforeLaunch: entry.beforeLaunch,
          timeoutMs: 1000,
        }),
      ).toMatchObject({ termination: "unavailable" });
      expect(confinement).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await entry.close();
    }
  });
  it.each([false, true])(
    "checks prepared command consent at the actual final spawn boundary (Clear=%s)",
    async (clear) => {
      const f = await fixture();
      await f.service.pointGoogleCliAccount(windowId, selected);
      const project = join(f.directory, "project");
      const temporary = join(f.directory, "temporary");
      await mkdir(project);
      await mkdir(temporary);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { realpath } =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fsPromises.realpath).mockImplementation(async (path) => {
        const value = await realpath(path);
        if (
          String(path).includes("/cloud-cli/google-octant-harness-") &&
          String(path).endsWith("/configuration")
        ) {
          entered.resolve();
          await release.promise;
        }
        return value;
      });
      const spawn = vi.fn(() => {
        throw new Error("Sentinel spawn; no process is started by this fixture");
      });
      const confinement = vi
        .fn<ProcessConfinementPort["prepare"]>()
        .mockImplementation(() => ({ command: process.execPath, args: [] }));
      const port = new RepositoryTestProcessPort({
        platform: "linux",
        temporaryDirectory: temporary,
        harnessShellScriptDirectory: f.scriptRoot,
        confinement: { prepare: confinement },
        spawn,
      });
      const shell = createNativeHarnessShell({
        process: port,
        scriptDirectory: f.scriptRoot,
        googleCliCredentials: f.commands.prepare,
      });
      const running = shell.run({ command: "gcloud projects list", cwd: project, timeoutMs: 1000 });
      await entered.promise;
      if (clear) await f.service.clearGoogleCliAccount(windowId);
      release.resolve();
      await expect(running).resolves.toMatchObject({ status: "unavailable" });
      expect(confinement).toHaveBeenCalledOnce();
      const grants = confinement.mock.calls[0]?.[0];
      expect(grants?.additionalWriteRoots).toHaveLength(1);
      const writable = grants?.additionalWriteRoots?.[0];
      if (writable === undefined) throw new Error("Configuration write grant missing");
      expect(writable).toMatch(/\/cloud-cli\/google-octant-harness-[^/]+\/configuration$/);
      expect(grants?.readRoots).toContain(dirname(writable));
      expect(grants?.readRoots).not.toContain(dirname(dirname(writable)));
      expect(grants?.additionalWriteRoots).not.toContain(f.scriptRoot);
      expect(spawn).toHaveBeenCalledTimes(clear ? 0 : 1);
    },
  );
  it.each(["another-command", "configuration-link"] as const)(
    "refuses a %s config grant before confinement or spawn",
    async (failure) => {
      const f = await fixture();
      await f.service.pointGoogleCliAccount(windowId, selected);
      const project = join(f.directory, "project");
      const temporary = join(f.directory, "temporary");
      await mkdir(project);
      await mkdir(temporary);
      const commandDirectory = await fsPromises.mkdtemp(join(f.scriptRoot, "octant-harness-"));
      await writeFile(join(commandDirectory, "command.sh"), "gcloud projects list\n");
      const resourceCommand =
        failure === "another-command"
          ? await fsPromises.mkdtemp(join(f.scriptRoot, "octant-harness-"))
          : commandDirectory;
      const entry = await f.commands.prepare(resourceCommand);
      if (entry?.status !== "ready" || entry.configurationDirectory === undefined)
        throw new Error("Google resources missing");
      if (failure === "configuration-link") {
        const outside = join(f.directory, "outside");
        await mkdir(outside);
        await rm(entry.configurationDirectory, { recursive: true });
        await symlink(outside, entry.configurationDirectory);
      }
      const spawn = vi.fn(() => {
        throw new Error("Sentinel must never spawn");
      });
      const confinement = vi.fn(() => ({ command: process.execPath, args: [] }));
      const port = new RepositoryTestProcessPort({
        platform: "linux",
        temporaryDirectory: temporary,
        harnessShellScriptDirectory: f.scriptRoot,
        confinement: { prepare: confinement },
        spawn,
      });
      try {
        const result = await port.executeShellScript({
          script: join(commandDirectory, "command.sh"),
          cwd: project,
          environment: entry.environment,
          cloudCliConfigurationDirectory: entry.configurationDirectory,
          beforeLaunch: entry.beforeLaunch,
          timeoutMs: 1000,
        });
        expect(result.termination).toBe("unavailable");
        expect(confinement).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await entry.close();
      }
    },
  );
  it("persists only explicit consent metadata and recovers the current account through the real broker", async () => {
    const f = await fixture();
    const client = createSecretStoresClient({
      baseUrl: "http://127.0.0.1",
      windowCapability: capability,
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
        const response = await f.dispatch(new Request(input, init));
        if (response === undefined) throw new Error("Product route unavailable");
        return response;
      }),
    });
    expect(await client.execute(command)).toEqual({
      kind: "secret-stores-google-cli-account",
      reference: selected,
    });
    expect((await f.dispatch(f.request({ kind: "read-google-cli-account" })))?.status).toBe(200);
    expect(f.journalText()).toContain(selected.serviceAccountEmail);
    expect(f.journalText()).not.toContain("PRIVATE KEY");
    expect(f.journalText()).not.toContain("fixture-issued-short-token");
    expect(await f.client.googleCliSession?.()).toMatchObject({
      status: "issued",
      serviceAccountEmail: selected.serviceAccountEmail,
    });
    expect(await f.service.readGoogleCliAccount()).toMatchObject({
      kind: "secret-stores-google-cli-account",
      reference: selected,
      sessionExpiresAt: expect.any(String),
    });
  });
  it.each(["revoke", "expire", "rotate"] as const)(
    "refuses an already-bound request whose body finishes after %s",
    async (change) => {
      const f = await fixture();
      let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          writer = controller;
        },
      });
      const init = {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body,
        duplex: "half" as const,
      };
      const pending = f.dispatch(new Request("http://127.0.0.1/api/secret-stores/commands", init));
      if (change === "expire") f.clock.now += WINDOW_AUTHORITY_TTL_MS;
      else {
        f.store.revoke(windowId);
        if (change === "rotate")
          f.store.register({ windowId, capability: "E".repeat(43), now: f.clock.now });
      }
      writer?.enqueue(new TextEncoder().encode(JSON.stringify(command)));
      writer?.close();
      expect((await pending)?.status).toBe(401);
      expect(await f.client.googleCliReference?.()).toEqual({ status: "none" });
      expect(f.journalText()).toBe("[]");
    },
  );
  it("rechecks a queued account change before it reaches the broker", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.client.googleCliReference;
    if (original === undefined) throw new Error("Google broker port missing");
    vi.spyOn(f.client, "googleCliReference").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return original();
    });
    const point = vi.spyOn(f.service, "pointGoogleCliAccount");
    const first = f.service.pointGoogleCliAccount(windowId, selected);
    await entered.promise;
    const pending = f.dispatch(
      f.request({ ...command, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
    );
    await vi.waitFor(() => expect(point).toHaveBeenCalledTimes(2));
    f.store.revoke(windowId);
    release.resolve();
    await first;
    expect((await pending)?.status).toBe(401);
    expect(await f.client.googleCliReference?.()).toMatchObject({
      status: "linked",
      pointer: selected,
    });
  });
  it("keeps the person's exact consent audited when a committed broker selection loses its reply", async () => {
    const f = await fixture();
    const original = f.client.pointGoogleCli;
    if (original === undefined) throw new Error("Google broker port unavailable");
    vi.spyOn(f.client, "pointGoogleCli").mockImplementationOnce(async (pointer) => {
      await original(pointer);
      return { status: "broker-unavailable" };
    });
    const response = await f.dispatch(f.request(command));
    expect(await response?.json()).toMatchObject({
      kind: "secret-stores-refused",
      message: expect.stringContaining("did not confirm"),
    });
    expect(await f.client.googleCliReference?.()).toMatchObject({
      status: "linked",
      pointer: selected,
    });
    expect(f.journalText()).toContain("credential-reference.requested");
    expect(f.journalText()).not.toContain("credential-reference.set");
    expect(f.journalText()).toContain(selected.serviceAccountEmail);
    expect(f.journalText()).not.toContain("PRIVATE KEY");
  });
  it("does not leave a new account configured when the real journal append refuses", async () => {
    const f = await fixture();
    f.failJournal();
    const response = await f.dispatch(f.request(command));
    expect(await response?.json()).toMatchObject({
      kind: "secret-stores-refused",
      reason: "journal-unavailable",
    });
    expect(await f.client.googleCliReference?.()).toEqual({ status: "none" });
  });
  it("restores the earlier account when intent was recorded but the committed append refuses", async () => {
    const f = await fixture();
    await f.service.pointGoogleCliAccount(windowId, selected);
    const point = vi.spyOn(f.client, "pointGoogleCli");
    f.failJournal("committed");
    const response = await f.dispatch(
      f.request({ ...command, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
    );
    expect(await response?.json()).toMatchObject({
      kind: "secret-stores-refused",
      reason: "journal-unavailable",
    });
    expect(point).toHaveBeenCalledOnce();
    expect(await f.client.googleCliReference?.()).toMatchObject({
      status: "linked",
      pointer: selected,
    });
  });
});
