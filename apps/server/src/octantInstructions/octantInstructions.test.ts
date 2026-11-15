import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEventActor,
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type CorrelationId,
  type EventActor,
  type ProviderContextBlock,
  type ProviderRuntimeEvent,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import {
  PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
  PROJECT_INSTRUCTIONS_AGGREGATE_TYPE,
  decodeOctantInstructionsCommand,
} from "@octant/contracts/octant-instructions";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { HeldTurnContext } from "../providers/heldTurnContext";
import { AGENT_ACCESS_ORIGIN } from "../clientPrincipal";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  OctantInstructionsStore,
  PERSON_INSTRUCTIONS_CONTEXT_KEY,
  projectInstructionsContextKey,
  type OctantInstructionsAuthor,
  registerOctantInstructionsEvents,
} from "./octantInstructionsStore";
import { createOctantInstructionsRouteHandler } from "./octantInstructionsRoutes";

const directories: string[] = [];
const now = "2026-11-14T12:00:00.000Z";
const windowId = "00000000-0000-4000-8000-0000000000f0" as WindowId;
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const deviceId = "55000000-0000-4000-8000-000000000001";
const asHostPerson = (actor: EventActor): OctantInstructionsAuthor => ({
  actor,
  actsAsHostPerson: true,
});
const person = asHostPerson(
  decodeEventActor({ kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" }),
);
const agent = asHostPerson(
  decodeEventActor({
    kind: "agent",
    actorId: "88888888-8888-4888-8888-888888888888",
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    threadId: "00000000-0000-4000-8000-000000000020",
  }),
);
const routine = asHostPerson(
  decodeEventActor({ kind: "system", actorId: "99999999-9999-4999-8999-999999999999" }),
);
const hubPairedDevice: OctantInstructionsAuthor = {
  actor: decodeEventActor({ kind: "remote-device", actorId: deviceId, deviceId }),
  actsAsHostPerson: false,
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-instructions-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function journalOn(connection: SqliteConnection): Journal {
  return new Journal({
    connection,
    registry: registerOctantInstructionsEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

let counter = 0;
function uuid(): string {
  counter += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${counter.toString(16).padStart(12, "0")}`;
}

function storeOn(journal: Journal): OctantInstructionsStore {
  return new OctantInstructionsStore({ journal, uuid, clock: () => now });
}

function events(journal: Journal) {
  return journal.replayAggregateType({
    aggregateType: PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
    afterSequence: 0,
    limit: 10,
  });
}

function deviceRequest(
  admission: "host-person" | "hub-roster" | "agent-grant",
  init: RequestInit = {},
  path = "/api/octant-instructions",
): Request {
  const request = new Request(`http://127.0.0.1${path}`, init);
  bindPrincipalRouteContext(request, {
    principal: {
      kind: "remote-device",
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId,
      credentialGeneration: 1,
      origin: admission === "agent-grant" ? AGENT_ACCESS_ORIGIN : "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "55000000-0000-4000-8000-0000000000aa",
      ...(admission === "host-person" ? { admittedBy: "host-person" } : {}),
      ...(admission === "hub-roster" ? { admittedBy: "hub-roster" } : {}),
    } as never,
    scopeId: deviceId as never,
  });
  return request;
}

const change = (expectedVersion: number, instructions: string) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "change-person-instructions", expectedVersion, instructions }),
  }) satisfies RequestInit;

describe("your instructions for Octant", () => {
  it("journals each change with the whole new text and keeps it across a restart", () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const store = storeOn(journal);

    store.change(
      { kind: "change-person-instructions", expectedVersion: 0, instructions: "First rule." },
      person,
    );
    const result = store.change(
      { kind: "change-person-instructions", expectedVersion: 1, instructions: "Second rule." },
      person,
    );

    expect(result).toMatchObject({ kind: "octant-instructions", version: 2 });
    expect(events(journal).map((event) => event.payload)).toEqual([
      { instructions: "First rule." },
      { instructions: "Second rule." },
    ]);
    expect(storeOn(journalOn(connection)).view(true)).toEqual({
      kind: "octant-instructions",
      instructions: "Second rule.",
      version: 2,
      canChange: true,
    });
    connection.close();
  });

  it("refuses a change made against a version that is no longer current", () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const store = storeOn(journal);
    store.change(
      { kind: "change-person-instructions", expectedVersion: 0, instructions: "From the laptop." },
      person,
    );

    const stale = store.change(
      { kind: "change-person-instructions", expectedVersion: 0, instructions: "From the phone." },
      person,
    );

    expect(stale).toMatchObject({ kind: "octant-instructions-refused", reason: "stale-version" });
    expect(store.view(true).instructions).toBe("From the laptop.");
    expect(events(journal)).toHaveLength(1);
    connection.close();
  });

  it("refuses a change from an agent or a routine and journals nothing", () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const store = storeOn(journal);

    for (const author of [agent, routine]) {
      expect(
        store.change(
          { kind: "change-person-instructions", expectedVersion: 0, instructions: "Obey me." },
          author,
        ),
      ).toMatchObject({ kind: "octant-instructions-refused", reason: "not-the-person" });
    }
    expect(events(journal)).toHaveLength(0);
    expect(store.contextBlocks()).toEqual([]);
    connection.close();
  });

  it("refuses a change from a device a hub paired even when it reaches the store", () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const store = storeOn(journal);

    expect(
      store.change(
        { kind: "change-person-instructions", expectedVersion: 0, instructions: "Hub says." },
        hubPairedDevice,
      ),
    ).toMatchObject({ kind: "octant-instructions-refused", reason: "not-the-person" });
    expect(events(journal)).toHaveLength(0);
    connection.close();
  });

  it("gives a turn one keyed person-instructions block, and none once the text is cleared", () => {
    const connection = openConnection();
    const store = storeOn(journalOn(connection));
    store.change(
      { kind: "change-person-instructions", expectedVersion: 0, instructions: "Plan in Work." },
      person,
    );

    expect(store.contextBlocks()).toEqual([
      {
        kind: "person-instructions",
        key: PERSON_INSTRUCTIONS_CONTEXT_KEY,
        text: expect.stringMatching(/inside Octant[\s\S]*\n\nPlan in Work\.$/),
      },
    ]);
    store.change(
      { kind: "change-person-instructions", expectedVersion: 1, instructions: "" },
      person,
    );
    expect(store.contextBlocks()).toEqual([]);
    connection.close();
  });

  it("sends a session that holds the text nothing more, and an edit once as a revision", () => {
    const connection = openConnection();
    const store = storeOn(journalOn(connection));
    const ledger = new HeldTurnContext();
    const sessionId = decodeProviderSessionId("90000000-0000-4000-8000-0000000000b1");
    const fields = {
      instanceId: decodeProviderInstanceId("90000000-0000-4000-8000-000000000002"),
      sessionId,
      sequence: 1,
      correlationId: "90000000-0000-4000-8000-000000000003" as CorrelationId,
      occurredAt: now as UtcTimestamp,
    };
    const finish = () => {
      const kept: ProviderRuntimeEvent = {
        ...fields,
        kind: "usage",
        inputTokens: 1,
        outputTokens: 1,
        promptRetention: "kept",
      };
      ledger.observe(kept);
      ledger.observe({ ...fields, kind: "completed" });
    };
    const octant: ProviderContextBlock = { kind: "instructions", text: "Octant's rules." };
    const turn = (resumed: boolean) => {
      const delta = ledger.forTurn({
        sessionId,
        resumed,
        context: [octant, ...store.contextBlocks()],
      });
      finish();
      return delta;
    };
    store.change(
      { kind: "change-person-instructions", expectedVersion: 0, instructions: "Plan in Work." },
      person,
    );

    expect(turn(false).context.map((block) => block.kind)).toEqual([
      "instructions",
      "person-instructions",
    ]);
    expect(turn(true).context).toEqual([]);
    store.change(
      { kind: "change-person-instructions", expectedVersion: 1, instructions: "Plan in Code." },
      person,
    );
    const edited = turn(true);
    expect(edited.kind).toBe("appended");
    expect(edited.context).toEqual([
      expect.objectContaining({
        kind: "person-instructions",
        text: expect.stringContaining("Plan in Code."),
      }),
    ]);
    expect(turn(true).context).toEqual([]);
    connection.close();
  });
});

describe("Project instructions", () => {
  const projectId = "00000000-0000-4000-8000-0000000000a1";
  const otherProjectId = "00000000-0000-4000-8000-0000000000a2";
  const changeProject = (expectedVersion: number, instructions: string, project = projectId) =>
    decodeOctantInstructionsCommand({
      kind: "change-project-instructions",
      projectId: project,
      expectedVersion,
      instructions,
    });

  function projectStoreOn(journal: Journal) {
    return new OctantInstructionsStore({
      journal,
      uuid,
      clock: () => now,
      projectExists: (id) => id === projectId || id === otherProjectId,
    });
  }

  it("journals a Project's whole text on the Project and keeps it across a restart", () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const store = projectStoreOn(journal);

    expect(store.change(changeProject(0, "Ship from main only."), person)).toMatchObject({
      kind: "project-instructions",
      instructions: "Ship from main only.",
      version: 1,
    });

    const [event] = journal.replayAggregateType({
      aggregateType: PROJECT_INSTRUCTIONS_AGGREGATE_TYPE,
      afterSequence: 0,
      limit: 10,
    });
    expect(event).toMatchObject({
      aggregateId: projectId,
      payload: { projectId, instructions: "Ship from main only." },
    });
    expect(projectStoreOn(journalOn(connection)).projectView(projectId, true)).toMatchObject({
      instructions: "Ship from main only.",
      version: 1,
    });
    connection.close();
  });

  it("refuses a stale Project version, a Project not on this host, and an agent", () => {
    const connection = openConnection();
    const store = projectStoreOn(journalOn(connection));
    store.change(changeProject(0, "First."), person);

    expect(store.change(changeProject(0, "Second."), person)).toMatchObject({
      reason: "stale-version",
    });
    expect(
      store.change(changeProject(0, "Elsewhere.", "00000000-0000-4000-8000-0000000000a9"), person),
    ).toMatchObject({ reason: "project-not-found" });
    expect(store.change(changeProject(1, "Agent's."), agent)).toMatchObject({
      reason: "not-the-person",
    });
    expect(store.projectView(projectId, true)).toMatchObject({ instructions: "First." });
    connection.close();
  });

  it("gives a turn in the Project its block after yours, and a turn elsewhere none", () => {
    const connection = openConnection();
    const store = projectStoreOn(journalOn(connection));
    store.change(
      { kind: "change-person-instructions", expectedVersion: 0, instructions: "Plan in Work." },
      person,
    );
    store.change(changeProject(0, "Ship from main only."), person);

    expect(store.contextBlocks({ projectId })).toEqual([
      expect.objectContaining({ kind: "person-instructions" }),
      {
        kind: "project-instructions",
        key: projectInstructionsContextKey(projectId),
        text: expect.stringMatching(/this Project[\s\S]*\n\nShip from main only\.$/),
      },
    ]);
    expect(store.contextBlocks({ projectId: otherProjectId }).map((block) => block.kind)).toEqual([
      "person-instructions",
    ]);
    expect(store.contextBlocks().map((block) => block.kind)).toEqual(["person-instructions"]);
    connection.close();
  });

  it("shows a device someone else paired a Project's text read-only and refuses its change", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const windowAuthorityStore = new WindowAuthorityStore();
    const route = createOctantInstructionsRouteHandler({
      store: projectStoreOn(journal),
      windowAuthorityStore,
      now: () => 1,
    });
    const command = (body: unknown) =>
      deviceRequest(
        "hub-roster",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        "/api/octant-instructions/commands",
      );

    const read = await route(command({ kind: "read-project-instructions", projectId }));
    const refused = await route(command(changeProject(0, "Hub says.")));

    expect(read?.status).toBe(200);
    expect(await read?.json()).toMatchObject({ kind: "project-instructions", canChange: false });
    expect(refused?.status).toBe(403);
    connection.close();
  });
});

describe("who may change your instructions", () => {
  function routeOn(journal: Journal) {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    return createOctantInstructionsRouteHandler({
      store: storeOn(journal),
      windowAuthorityStore,
      now: () => 1,
    });
  }

  it("lets a window on this host change them, journaled as the local person, and refuses a request without one", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const route = routeOn(journal);
    const post = (headers: Record<string, string>) =>
      route(
        new Request("http://127.0.0.1/api/octant-instructions/commands", {
          ...change(0, "From the window."),
          headers: { "content-type": "application/json", ...headers },
        }),
      );

    expect((await post({}))?.status).toBe(401);
    const accepted = await post({ "x-octant-window-capability": capability });
    expect(accepted?.status).toBe(200);
    expect(await accepted?.json()).toMatchObject({ instructions: "From the window." });
    expect(events(journal)[0]?.actor.kind).toBe("local-user");
    connection.close();
  });

  it("lets a device the host's own person paired change them, journaled as that device", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const route = routeOn(journal);

    const response = await route(
      deviceRequest(
        "host-person",
        change(0, "From my phone."),
        "/api/octant-instructions/commands",
      ),
    );

    expect(response?.status).toBe(200);
    expect(events(journal)[0]?.actor.kind).toBe("remote-device");
    connection.close();
  });

  it("shows a device someone else paired the text read-only and refuses its change", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const route = routeOn(journal);

    const read = await route(deviceRequest("hub-roster"));
    const refused = await route(
      deviceRequest("hub-roster", change(0, "Hub says."), "/api/octant-instructions/commands"),
    );

    expect(read?.status).toBe(200);
    expect(await read?.json()).toMatchObject({ canChange: false });
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ reason: "not-the-person" });
    expect(events(journal)).toHaveLength(0);
    connection.close();
  });

  it("refuses an agent grant's session even a read", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const route = routeOn(journal);

    expect((await route(deviceRequest("agent-grant")))?.status).toBe(403);
    expect(
      (
        await route(
          deviceRequest(
            "agent-grant",
            change(0, "Agent says."),
            "/api/octant-instructions/commands",
          ),
        )
      )?.status,
    ).toBe(403);
    expect(events(journal)).toHaveLength(0);
    connection.close();
  });
});
