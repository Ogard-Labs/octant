import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOUD_MACHINES_AGGREGATE,
  CLOUD_MACHINES_EVENT_NAMES,
} from "@octant/contracts/cloud-machines";
import type { CloudMachineTarget } from "@octant/plugin-api/cloud-machine-target";
import { offeredCloudMachineTargets } from "@octant/plugin-host/cloud-machine-targets";
import { decodeWindowId } from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { createServerProjectRouteHandler } from "../serverProjects/serverProjectRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createCloudMachineRouteHandler } from "./cloudMachineRoutes";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ServerProjectStore } from "../serverProjects/serverProjectStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { ShieldServerStore } from "../shield/shieldServerStore";
import { CloudMachineService } from "./cloudMachineService";
import { fakeCloudMachineTarget } from "./fakeCloudMachineTarget.test-support";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openJournal() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-cloud-machines-")));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-11-14T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date().toISOString(),
  });
}

const CREDENTIAL_REFERENCE = "0b7e5c1a-4c1e-4f3a-9d2b-7a6c5e4d3c2b";
const person = { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID };

/** A host whose server registry, server Project catalog and machine lifecycle share one journal. */
function host(
  journal: Journal,
  target: CloudMachineTarget,
  facts = { installed: true, trusted: true, enabled: true },
) {
  const clock = () => "2026-11-14T12:00:00.000Z";
  const servers = new ShieldServerStore({
    journal,
    personActor: person,
    hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock,
  });
  servers.load();
  const folderChecks: Array<string> = [];
  const projects = new ServerProjectStore({
    journal,
    personActor: person,
    uuid: randomUUID,
    clock,
    servers: () => servers.servers(),
    // The machine answers the folder check with the folder it was asked for.
    connection: {
      run: async (server, input) => {
        folderChecks.push(server.alias);
        return {
          status: "ran",
          exitCode: 0,
          output: Buffer.from(`${input.args?.[0] ?? ""}\n`),
          truncated: false,
          errorOutput: "",
        };
      },
    },
  });
  projects.load();
  const handles: Array<{ reference: string; targetId: string; act: string }> = [];
  const machines = new CloudMachineService({
    journal,
    personActor: person,
    uuid: randomUUID,
    clock,
    now: () => Date.parse("2026-11-14T12:00:00.000Z"),
    targets: () =>
      offeredCloudMachineTargets([
        { targetId: "example.machines/fake", displayName: "Fake cloud", facts, target },
      ]),
    credentialHandle: async (input) => {
      handles.push(input);
      return input.reference === CREDENTIAL_REFERENCE
        ? { handleId: `handle-${handles.length}` }
        : undefined;
    },
    servers,
    projects,
  });
  machines.load();
  return { machines, projects, servers, handles, folderChecks };
}

const createInput = {
  targetId: "example.machines/fake",
  name: "Build box",
  recipe: {
    image: "ubuntu-24.04",
    size: "small",
    region: "eu-1",
    setupScript: "apt-get -y update",
  },
  credentialReference: CREDENTIAL_REFERENCE,
  folder: "/home/octant/work",
} as const;

function journaledEventNames(journal: Journal): ReadonlyArray<string> {
  return journal
    .replayAggregateType({ aggregateType: CLOUD_MACHINES_AGGREGATE, afterSequence: 0, limit: 100 })
    .map((envelope) => String(envelope.eventName));
}

describe("machines in the person's cloud account", () => {
  it("creates a machine through an offered target, registers it as a server Project, and journals each step", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget();
    const { machines, projects, servers, handles, folderChecks } = host(journal, fake.target);

    const created = await machines.create({ ...createInput, principal: "local-window" });

    if (created.kind !== "changed" || created.machine === undefined)
      throw Error(`Expected a created machine, got ${JSON.stringify(created)}`);
    const machine = created.machine;
    expect(machine.lifecycle).toBe("created");
    expect(machine.state).toBe("running");
    const project = projects
      .projects()
      .find((entry) => String(entry.id) === String(machine.projectId));
    expect(project).toMatchObject({ name: "Build box", folder: "/home/octant/work" });
    expect(servers.servers()).toEqual([
      expect.objectContaining({ alias: "m-1.machines.test", user: "octant", profile: "read-only" }),
    ]);
    expect(folderChecks).toEqual(["m-1.machines.test"]);
    expect(machines.machineForProject(String(machine.projectId))).toMatchObject({
      machineId: machine.id,
      state: "running",
    });

    // The target saw a broker handle for this act, never the reference, and
    // the journal names the reference, never a handle.
    expect(handles).toEqual([
      { reference: CREDENTIAL_REFERENCE, targetId: "example.machines/fake", act: "create" },
    ]);
    expect(fake.calls).toEqual([{ act: "create", credential: { handleId: "handle-1" } }]);
    expect(journaledEventNames(journal)).toEqual([
      CLOUD_MACHINES_EVENT_NAMES.creationRequested,
      CLOUD_MACHINES_EVENT_NAMES.created,
      CLOUD_MACHINES_EVENT_NAMES.projectBound,
    ]);
    expect(
      JSON.stringify(
        journal.replayAggregateType({
          aggregateType: CLOUD_MACHINES_AGGREGATE,
          afterSequence: 0,
          limit: 100,
        }),
      ),
    ).not.toContain("handle-1");

    // A restarted host rebuilds the same machine from the journal.
    const restarted = host(journal, fake.target);
    expect(restarted.machines.view().machines).toEqual([machine]);
  });

  it("refuses an agent, a routine and a paired device, and asks the provider for nothing", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget();
    const { machines, handles } = host(journal, fake.target);

    for (const principal of ["agent", "routine"] as const) {
      expect(await machines.create({ ...createInput, principal })).toMatchObject({
        kind: "refused",
        reason: "needs-person",
      });
    }
    expect(await machines.create({ ...createInput, principal: "remote-device" })).toMatchObject({
      kind: "refused",
      reason: "needs-local-window",
    });

    const created = await machines.create({ ...createInput, principal: "local-window" });
    if (created.kind !== "changed" || created.machine === undefined)
      throw Error("Expected fixture");
    const machineId = String(created.machine.id);
    for (const principal of ["agent", "routine"] as const) {
      expect(await machines.suspend({ machineId, principal })).toMatchObject({
        reason: "needs-person",
      });
      expect(await machines.resume({ machineId, principal })).toMatchObject({
        reason: "needs-person",
      });
      expect(machines.requestDestroy({ machineId, principal })).toMatchObject({
        reason: "needs-person",
      });
    }
    expect(fake.calls.map((call) => call.act)).toEqual(["create"]);
    expect(handles).toHaveLength(1);
  });

  it("destroys a machine only with the person's one confirmation for that machine", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget();
    const { machines } = host(journal, fake.target);
    const first = await machines.create({ ...createInput, principal: "local-window" });
    const second = await machines.create({
      ...createInput,
      name: "Other box",
      principal: "local-window",
    });
    if (first.kind !== "changed" || first.machine === undefined) throw Error("Expected fixture");
    if (second.kind !== "changed" || second.machine === undefined) throw Error("Expected fixture");
    const machineId = String(first.machine.id);

    expect(
      await machines.destroy({ machineId, confirmation: "guessed", principal: "local-window" }),
    ).toMatchObject({ kind: "refused", reason: "confirmation-required" });

    // A confirmation for one machine never destroys another.
    const otherAsk = machines.requestDestroy({
      machineId: String(second.machine.id),
      principal: "local-window",
    });
    if (otherAsk.kind !== "confirm") throw Error("Expected a confirmation");
    expect(
      await machines.destroy({
        machineId,
        confirmation: otherAsk.confirmation,
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused", reason: "confirmation-required" });
    expect(fake.calls.some((call) => call.act === "destroy")).toBe(false);

    const ask = machines.requestDestroy({ machineId, principal: "local-window" });
    if (ask.kind !== "confirm") throw Error("Expected a confirmation");
    expect(ask).toMatchObject({ name: "Build box", expiresAt: "2026-11-14T12:05:00.000Z" });
    const destroyed = await machines.destroy({
      machineId,
      confirmation: ask.confirmation,
      principal: "local-window",
    });
    expect(destroyed).toMatchObject({
      kind: "changed",
      machine: { lifecycle: "destroyed", state: "destroyed" },
    });
    expect(fake.machines.get("m-1")).toBe("destroyed");

    // The confirmation is spent.
    expect(
      await machines.destroy({
        machineId,
        confirmation: ask.confirmation,
        principal: "local-window",
      }),
    ).toMatchObject({ kind: "refused" });
    expect(fake.calls.filter((call) => call.act === "destroy")).toHaveLength(1);
    expect(journaledEventNames(journal)).toContain(CLOUD_MACHINES_EVENT_NAMES.destroyed);
  });

  it("offers no target from a disabled plugin and creates nothing", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget();
    const { machines, handles } = host(journal, fake.target, {
      installed: true,
      trusted: true,
      enabled: false,
    });

    expect(machines.view().targets).toEqual([]);
    expect(await machines.create({ ...createInput, principal: "local-window" })).toMatchObject({
      kind: "refused",
      reason: "target-not-offered",
    });
    expect(fake.calls).toEqual([]);
    expect(handles).toEqual([]);
    expect(journaledEventNames(journal)).toEqual([]);
  });

  it("shows a suspended machine on its server Project until the person resumes it", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget();
    const { machines } = host(journal, fake.target);
    const created = await machines.create({ ...createInput, principal: "local-window" });
    if (created.kind !== "changed" || created.machine === undefined)
      throw Error("Expected fixture");
    const machineId = String(created.machine.id);
    const projectId = String(created.machine.projectId);

    expect(await machines.resume({ machineId, principal: "local-window" })).toMatchObject({
      reason: "machine-not-suspended",
    });
    await machines.suspend({ machineId, principal: "local-window" });
    expect(machines.machineForProject(projectId)).toMatchObject({ state: "suspended" });
    expect(host(journal, fake.target).machines.machineForProject(projectId)).toMatchObject({
      state: "suspended",
    });
    await machines.resume({ machineId, principal: "local-window" });
    expect(machines.machineForProject(projectId)).toMatchObject({ state: "running" });
  });

  it("keeps a creation whose answer never arrived on record as uncertain, binding nothing", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget({ create: "throws" });
    const { machines, projects } = host(journal, fake.target);

    expect(await machines.create({ ...createInput, principal: "local-window" })).toMatchObject({
      kind: "refused",
      reason: "provider-failed",
    });
    expect(machines.view().machines).toEqual([
      expect.objectContaining({ lifecycle: "creation-uncertain", name: "Build box" }),
    ]);
    expect(projects.projects()).toEqual([]);
    expect(journaledEventNames(journal)).toEqual([
      CLOUD_MACHINES_EVENT_NAMES.creationRequested,
      CLOUD_MACHINES_EVENT_NAMES.creationEnded,
    ]);
  });

  it("takes the principal from the request, so only a local window creates, and the server Project shows the machine", async () => {
    const journal = openJournal();
    const fake = fakeCloudMachineTarget();
    const { machines, projects } = host(journal, fake.target);
    const windowId = decodeWindowId("00000000-0000-4000-8000-000000000935");
    const capability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
    const windows = new WindowAuthorityStore();
    windows.register({ windowId, capability, now: 0 });
    const route = createCloudMachineRouteHandler({
      service: machines,
      windowAuthorityStore: windows,
      now: () => 1,
    });
    const body = JSON.stringify({ kind: "create-cloud-machine", ...createInput });

    expect(
      (await route(new Request("http://127.0.0.1/api/cloud-machines", { method: "POST", body })))
        ?.status,
    ).toBe(401);
    const remote = new Request("http://127.0.0.1/api/cloud-machines", { method: "POST", body });
    bindPrincipalRouteContext(remote, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      } as never,
      scopeId: windowId,
    });
    // A device session that is not the host's own person is refused before the service.
    expect((await route(remote))?.status).toBe(403);
    expect(fake.calls).toEqual([]);

    const local = await route(
      new Request("http://127.0.0.1/api/cloud-machines", {
        method: "POST",
        body,
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(await local?.json()).toMatchObject({
      kind: "cloud-machines-updated",
      view: {
        targets: [{ targetId: "example.machines/fake", displayName: "Fake cloud" }],
        machines: [{ lifecycle: "created", state: "running" }],
      },
    });

    const catalog = createServerProjectRouteHandler({
      store: projects,
      windowAuthorityStore: windows,
      cloudMachineOf: (projectId) => machines.machineForProject(projectId),
      now: () => 1,
    });
    const listed = await catalog(
      new Request("http://127.0.0.1/api/server-projects", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(await listed?.json()).toMatchObject({
      view: {
        projects: [
          {
            name: "Build box",
            cloudMachine: { targetId: "example.machines/fake", state: "running" },
          },
        ],
      },
    });
  });
});
