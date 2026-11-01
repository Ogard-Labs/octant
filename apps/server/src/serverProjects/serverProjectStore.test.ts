import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { MAX_SERVER_PROJECTS } from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ServerConnection, type ServerCall } from "./serverConnection";
import { createServerProjectRouteHandler } from "./serverProjectRoutes";
import { ServerProjectStore } from "./serverProjectStore";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-server-projects-")));
  directories.push(directory);
  return directory;
}

function openJournal(directory: string) {
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-11-01T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date().toISOString(),
  });
}

const web: ShieldServer = {
  serverId: "5e7e1111-0000-4000-8000-000000000001" as ShieldServer["serverId"],
  alias: "web1",
  user: "deploy",
  profile: "operate",
  deployCommands: [],
};

/** A server that answers the folder check with `folder`, or the call `answer` gives. */
function answering(answer: () => ServerCall) {
  const calls: Array<{ alias: string; args: ReadonlyArray<string> }> = [];
  return {
    calls,
    connection: {
      run: async (server: { alias: string }, input: { args?: ReadonlyArray<string> }) => {
        calls.push({ alias: server.alias, args: input.args ?? [] });
        return answer();
      },
    },
  };
}

const resolvedTo = (folder: string): ServerCall => ({
  status: "ran",
  exitCode: 0,
  output: Buffer.from(`${folder}\n`),
  truncated: false,
});

function storeOn(
  journal: Journal,
  connection: ConstructorParameters<typeof ServerProjectStore>[0]["connection"],
  servers: () => ReadonlyArray<ShieldServer> = () => [web],
) {
  const store = new ServerProjectStore({
    journal,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => "2026-11-01T12:00:00.000Z",
    servers,
    connection,
  });
  store.load();
  return store;
}

describe("server Project catalog", () => {
  it("journals the folder's real path on the server and rebuilds the catalog after a restart", async () => {
    const directory = scratch();
    const server = answering(() => resolvedTo("/srv/app"));
    const store = storeOn(openJournal(directory), server.connection);
    const bound = await store.bind({
      name: "  App  ",
      serverId: String(web.serverId),
      folder: "/home/deploy/app-link",
      principal: "local-window",
    });
    expect(bound).toMatchObject({ kind: "changed", project: { name: "App", folder: "/srv/app" } });
    expect(server.calls).toEqual([{ alias: "web1", args: ["/home/deploy/app-link"] }]);

    const projectId = String(store.projects()[0]?.id);
    expect(store.rename({ projectId, name: "Site", principal: "local-window" }).kind).toBe(
      "changed",
    );
    const reloaded = storeOn(openJournal(directory), server.connection);
    expect(reloaded.projects()).toEqual([
      expect.objectContaining({ name: "Site", folder: "/srv/app", serverId: web.serverId }),
    ]);
    expect(reloaded.addressOf(projectId)).toEqual({
      kind: "address",
      server: { alias: "web1", user: "deploy" },
      folder: "/srv/app",
    });

    expect(reloaded.remove({ projectId, principal: "local-window" }).kind).toBe("changed");
    expect(storeOn(openJournal(directory), server.connection).projects()).toEqual([]);
  });

  it("binds nothing when the server cannot be reached or the folder is not there", async () => {
    const journal = openJournal(scratch());
    const unreachable = storeOn(
      journal,
      answering(() => ({ status: "unreachable", message: "Connection refused" })).connection,
    );
    expect(
      await unreachable.bind({
        name: "App",
        serverId: String(web.serverId),
        folder: "/srv/app",
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused", reason: "server-unreachable" });
    const missing = storeOn(
      journal,
      answering(() => ({ status: "ran", exitCode: 2, output: Buffer.alloc(0), truncated: false }))
        .connection,
    );
    expect(
      await missing.bind({
        name: "App",
        serverId: String(web.serverId),
        folder: "/srv/missing",
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused", reason: "folder-not-found" });
    expect(missing.projects()).toEqual([]);
    const whole = storeOn(journal, answering(() => resolvedTo("/")).connection);
    expect(
      await whole.bind({
        name: "Everything",
        serverId: String(web.serverId),
        folder: "/srv/..",
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused", reason: "folder-not-found" });
  });

  it("refuses a server that is not registered, and a caller that is not a local window", async () => {
    const server = answering(() => resolvedTo("/srv/app"));
    const store = storeOn(openJournal(scratch()), server.connection);
    expect(
      await store.bind({
        name: "App",
        serverId: "5e7e1111-0000-4000-8000-0000000000ff",
        folder: "/srv/app",
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused", reason: "server-not-registered" });
    expect(
      await store.bind({
        name: "App",
        serverId: String(web.serverId),
        folder: "/srv/app",
        principal: "remote-device",
      }),
    ).toMatchObject({ kind: "refused", reason: "needs-local-window" });
    expect(server.calls).toEqual([]);
  });

  it("holds the catalog to its limit when binds overlap, and binds nothing for a server removed meanwhile", async () => {
    const waiting: Array<() => void> = [];
    let servers: ReadonlyArray<ShieldServer> = [web];
    const store = storeOn(
      openJournal(scratch()),
      {
        run: () =>
          new Promise<ServerCall>((resolve) => waiting.push(() => resolve(resolvedTo("/srv/app")))),
      },
      () => servers,
    );
    const bind = (name: string) =>
      store.bind({
        name,
        serverId: String(web.serverId),
        folder: "/srv/app",
        principal: "local-window",
      });
    for (let index = 0; index < MAX_SERVER_PROJECTS - 1; index += 1) {
      const pending = bind(`App ${String(index)}`);
      waiting.shift()?.();
      await pending;
    }
    const first = bind("Last");
    const second = bind("One too many");
    for (const answer of waiting.splice(0)) answer();
    expect((await Promise.all([first, second])).map((change) => change.kind)).toEqual([
      "changed",
      "refused",
    ]);
    expect(store.projects()).toHaveLength(MAX_SERVER_PROJECTS);

    store.remove({ projectId: String(store.projects()[0]?.id), principal: "local-window" });
    const late = bind("Late");
    servers = [];
    waiting.shift()?.();
    expect(await late).toMatchObject({ kind: "refused", reason: "server-not-registered" });
  });

  it("keeps a Project whose server was removed from the registry, with no address", async () => {
    let servers: ReadonlyArray<ShieldServer> = [web];
    const store = storeOn(
      openJournal(scratch()),
      answering(() => resolvedTo("/srv/app")).connection,
      () => servers,
    );
    await store.bind({
      name: "App",
      serverId: String(web.serverId),
      folder: "/srv/app",
      principal: "local-window",
    });
    servers = [];
    const projectId = String(store.projects()[0]?.id);
    expect(store.addressOf(projectId)).toEqual({
      kind: "refused",
      reason: "server-not-registered",
    });
  });

  it("changes the catalog only for a local window's request", async () => {
    const store = storeOn(
      openJournal(scratch()),
      answering(() => resolvedTo("/srv/app")).connection,
    );
    const windowId = decodeWindowId("00000000-0000-4000-8000-000000000470");
    const capability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
    const windows = new WindowAuthorityStore();
    windows.register({ windowId, capability, now: 0 });
    const handler = createServerProjectRouteHandler({
      windowAuthorityStore: windows,
      store,
      now: () => 1,
    });
    const url = "http://127.0.0.1/api/server-projects";
    const body = JSON.stringify({
      kind: "bind-server-project",
      name: "App",
      serverId: web.serverId,
      folder: "/srv/app",
    });
    expect((await handler(new Request(url)))?.status).toBe(401);

    const remote = new Request(url, { method: "POST", body });
    bindPrincipalRouteContext(remote, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      } as never,
      scopeId: windowId,
    });
    const refused = await handler(remote);
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toMatchObject({ reason: "needs-local-window" });

    const local = await handler(
      new Request(url, {
        method: "POST",
        body,
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(local?.status).toBe(200);
    expect(await local?.json()).toMatchObject({
      kind: "server-projects-updated",
      view: { projects: [{ name: "App", folder: "/srv/app" }] },
    });
  });
});

describe.skipIf(!canRunThrowawaySshd)("binding a folder on a throwaway server", () => {
  let sshd: ThrowawaySshd;

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
  }, 30_000);

  afterAll(() => sshd?.stop());

  it("stores the folder's real path as the server resolves it", async () => {
    const folder = join(sshd.root, "app");
    mkdirSync(folder);
    symlinkSync(folder, join(sshd.root, "app-link"));
    const store = storeOn(
      openJournal(scratch()),
      new ServerConnection({ agentSocket: () => sshd.agentSocket, configFile: sshd.configFile }),
      () => [{ ...web, alias: sshd.alias, user: sshd.user }],
    );
    expect(
      await store.bind({
        name: "App",
        serverId: String(web.serverId),
        folder: join(sshd.root, "app-link"),
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "changed", project: { folder } });
    expect(
      await store.bind({
        name: "Gone",
        serverId: String(web.serverId),
        folder: join(sshd.root, "missing"),
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused", reason: "folder-not-found" });
  });
});
