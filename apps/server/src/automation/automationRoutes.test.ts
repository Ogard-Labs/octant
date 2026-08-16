import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAutomationCommandResult,
  decodeAutomationQueryResponse,
  decodeWindowId,
  type AutomationCommand,
  type AutomationId,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { AutomationCommandService } from "./automationCommandService";
import { AutomationEventStore, registerAutomationEvents } from "./automationEventStore";
import { AutomationProjection } from "./automationProjection";
import { createAutomationRouteHandler } from "./automationRoutes";
import {
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
  automationDefinitionDraftFixture,
} from "./automationTestFixtures";

const directories: Array<string> = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const now = AUTOMATION_TEST_NOW;
const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000401");
const remoteDeviceId = "00000000-0000-4000-8000-000000000402";

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let uuidCounter = 9_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `ef000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function automationId(suffix: string): AutomationId {
  return `fa000000-0000-4000-8000-00000000${suffix}` as AutomationId;
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

interface Harness {
  readonly handler: (request: Request) => Promise<Response | undefined>;
  readonly service: AutomationCommandService;
  readonly projection: AutomationProjection;
}

function activeProject(id: string, name: string) {
  return {
    id: id as never,
    name,
    type: "work" as const,
    binding: null as never,
    bindingRevisionId: "66666666-6666-4666-8666-666666666666" as never,
    lifecycle: "active" as const,
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
  };
}

function createHarness(): Harness {
  const connection = openConnection();
  const registry = registerAutomationEvents(new EventRegistry());
  const projection = new AutomationProjection();
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => now,
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  const service = new AutomationCommandService({
    store,
    projection,
    hostId: "local",
    clock: () => now,
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability: windowCapability, now: 0 });
  const handler = createAutomationRouteHandler({
    projection,
    commands: service,
    windowAuthorityStore: authority,
    projects: {
      bootstrap: async () => ({
        // Only the fixture Project is accessible; AUTOMATION_TEST_IDS.otherProject is not.
        active: [activeProject(AUTOMATION_TEST_IDS.project, "Automation Project")],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    hostId: "local",
    now: () => 1,
  });
  return { handler, service, projection };
}

const localPrincipal = {
  kind: "local-window",
  windowId: "automation-window-1",
  capabilityGeneration: 0,
} as const;

function seedAutomation(
  harness: Harness,
  id: AutomationId,
  overrides: Record<string, unknown> = {},
) {
  const result = harness.service.execute({
    kind: "create-automation",
    automationId: id,
    expectedVersion: 0,
    principal: localPrincipal,
    origin: { kind: "interactive" },
    definition: automationDefinitionDraftFixture(),
    ...overrides,
  } as unknown as AutomationCommand);
  expect(result.kind).toBe("automation-created");
}

function seedInaccessibleAutomation(harness: Harness, id: AutomationId) {
  const draft = automationDefinitionDraftFixture();
  seedAutomation(harness, id, {
    definition: {
      ...draft,
      displayName: "Hidden automation",
      projectId: AUTOMATION_TEST_IDS.otherProject,
      binding: { ...draft.binding, projectId: AUTOMATION_TEST_IDS.otherProject },
      executionProfile: {
        ...draft.executionProfile,
        projectId: AUTOMATION_TEST_IDS.otherProject,
      },
    },
  });
}

function getRequest(path: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { "x-octant-window-capability": windowCapability },
  });
}

function postCommand(body: unknown): Request {
  return new Request("http://127.0.0.1/api/automations/commands", {
    method: "POST",
    headers: {
      "x-octant-window-capability": windowCapability,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response | undefined): Promise<unknown> {
  expect(response).toBeDefined();
  return (response as Response).json();
}

describe("automation routes", () => {
  it("passes through unrelated paths", async () => {
    const { handler } = createHarness();
    expect(await handler(getRequest("/api/unrelated"))).toBeUndefined();
    expect(await handler(getRequest("/api/automations/unknown"))).toBeDefined();
    const unknown = await handler(getRequest("/api/automations/unknown"));
    expect(unknown?.status).toBe(400);
  });

  it("rejects non-loopback requests and disallowed origins before authentication", async () => {
    const { handler } = createHarness();
    const nonLoopback = await handler(
      new Request("http://automation.example/api/automations/list?mode=all"),
    );
    expect(nonLoopback?.status).toBe(400);
    const badOrigin = await handler(
      new Request("http://127.0.0.1/api/automations/list?mode=all", {
        headers: { origin: "https://automation.example" },
      }),
    );
    expect(badOrigin?.status).toBe(400);
  });

  it("answers CORS preflight without exposing state", async () => {
    const { handler } = createHarness();
    const response = await handler(
      new Request("http://127.0.0.1/api/automations/list", {
        method: "OPTIONS",
        headers: { origin: "http://127.0.0.1:3000" },
      }),
    );
    expect(response?.status).toBe(204);
  });

  it("rejects requests without a valid window capability", async () => {
    const { handler } = createHarness();
    const missing = await handler(new Request("http://127.0.0.1/api/automations/list?mode=all"));
    expect(missing?.status).toBe(401);
    const wrong = await handler(
      new Request("http://127.0.0.1/api/automations/list?mode=all", {
        headers: { "x-octant-window-capability": "B".repeat(43) },
      }),
    );
    expect(wrong?.status).toBe(401);
  });

  it("rejects principal identity smuggled through the query string", async () => {
    const { handler } = createHarness();
    const response = await handler(getRequest("/api/automations/list?mode=all&hostId=evil"));
    expect(response?.status).toBe(400);
  });

  it("lists bounded sanitized summaries for accessible Projects only", async () => {
    const harness = createHarness();
    seedAutomation(harness, automationId("aa01"));
    seedInaccessibleAutomation(harness, automationId("aa02"));

    const body = await json(await harness.handler(getRequest("/api/automations/list?mode=all")));
    const decoded = decodeAutomationQueryResponse(body);
    expect(decoded.kind).toBe("automation-list");
    if (decoded.kind !== "automation-list") return;
    expect(decoded.items.map((item) => String(item.id))).toEqual([automationId("aa01")]);
    expect(decoded.items[0]?.nextDueAt).not.toBeNull();
    // Sanitized: no prompts, bindings, profiles, or delivery targets on the wire.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("taskPrompt");
    expect(raw).not.toContain("Summarize the Project's open work.");
    expect(raw).not.toContain("binding");
    expect(raw).not.toContain("authorityProfile");
  });

  it("filters lists by mode and requested Project, failing closed on foreign Projects", async () => {
    const harness = createHarness();
    seedAutomation(harness, automationId("ab01"));

    const codeOnly = decodeAutomationQueryResponse(
      await json(await harness.handler(getRequest("/api/automations/list?mode=code"))),
    );
    if (codeOnly.kind !== "automation-list") throw new Error("expected list");
    expect(codeOnly.items).toHaveLength(0);

    const foreign = decodeAutomationQueryResponse(
      await json(
        await harness.handler(
          getRequest(
            `/api/automations/list?mode=all&projectId=${AUTOMATION_TEST_IDS.otherProject}`,
          ),
        ),
      ),
    );
    if (foreign.kind !== "automation-list") throw new Error("expected list");
    expect(foreign.items).toHaveLength(0);
  });

  it("pages summaries newest-first with an opaque cursor", async () => {
    const harness = createHarness();
    seedAutomation(harness, automationId("ac01"));
    seedAutomation(harness, automationId("ac02"));
    seedAutomation(harness, automationId("ac03"));

    const first = decodeAutomationQueryResponse(
      await json(await harness.handler(getRequest("/api/automations/list?mode=all&limit=2"))),
    );
    if (first.kind !== "automation-list") throw new Error("expected list");
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = decodeAutomationQueryResponse(
      await json(
        await harness.handler(
          getRequest(
            `/api/automations/list?mode=all&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          ),
        ),
      ),
    );
    if (second.kind !== "automation-list") throw new Error("expected list");
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.items, ...second.items].map((item) => String(item.id));
    expect(new Set(ids).size).toBe(3);
  });

  it("returns detail with bounded run history and 404s unknown or foreign automations", async () => {
    const harness = createHarness();
    seedAutomation(harness, automationId("ad01"));
    seedInaccessibleAutomation(harness, automationId("ad02"));
    const accepted = harness.service.execute({
      kind: "run-now-automation",
      automationId: automationId("ad01"),
      expectedVersion: 1,
      principal: localPrincipal,
      origin: { kind: "interactive" },
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as unknown as AutomationCommand);
    expect(accepted.kind).toBe("automation-run-accepted");

    const detail = decodeAutomationQueryResponse(
      await json(
        await harness.handler(
          getRequest(`/api/automations/get?automationId=${automationId("ad01")}`),
        ),
      ),
    );
    expect(detail.kind).toBe("automation-detail");
    if (detail.kind !== "automation-detail") return;
    expect(String(detail.automation.id)).toBe(automationId("ad01"));
    expect(detail.runs).toHaveLength(1);

    const missing = await harness.handler(
      getRequest("/api/automations/get?automationId=fa000000-0000-4000-8000-0000000000ff"),
    );
    expect(missing?.status).toBe(404);
    const foreign = await harness.handler(
      getRequest(`/api/automations/get?automationId=${automationId("ad02")}`),
    );
    expect(foreign?.status).toBe(404);
  });

  it("pages run history newest-first and keeps archived history readable", async () => {
    const harness = createHarness();
    seedAutomation(harness, automationId("ae01"));
    const first = harness.service.execute({
      kind: "run-now-automation",
      automationId: automationId("ae01"),
      expectedVersion: 1,
      principal: localPrincipal,
      origin: { kind: "interactive" },
      runNowRequestId: "fb000000-0000-4000-8000-000000000001",
    } as unknown as AutomationCommand);
    if (first.kind !== "automation-run-accepted") throw new Error("expected run");
    const cancelled = harness.service.execute({
      kind: "cancel-current-automation-run",
      automationId: automationId("ae01"),
      expectedVersion: 1,
      principal: localPrincipal,
      origin: { kind: "interactive" },
      runId: first.run.id,
      cancelRunRequestId: "fb000000-0000-4000-8000-000000000002",
      expectedRunVersion: first.run.version,
    } as unknown as AutomationCommand);
    expect(cancelled.kind).toBe("automation-run-cancelled");
    const second = harness.service.execute({
      kind: "run-now-automation",
      automationId: automationId("ae01"),
      expectedVersion: 1,
      principal: localPrincipal,
      origin: { kind: "interactive" },
      runNowRequestId: "fb000000-0000-4000-8000-000000000003",
    } as unknown as AutomationCommand);
    expect(second.kind).toBe("automation-run-accepted");
    const archive = harness.service.execute({
      kind: "archive-automation",
      automationId: automationId("ae01"),
      expectedVersion: 1,
      principal: localPrincipal,
      origin: { kind: "interactive" },
    } as unknown as AutomationCommand);
    expect(archive.kind).toBe("automation-archived");

    const page = decodeAutomationQueryResponse(
      await json(
        await harness.handler(
          getRequest(`/api/automations/history?automationId=${automationId("ae01")}&limit=1`),
        ),
      ),
    );
    expect(page.kind).toBe("automation-history");
    if (page.kind !== "automation-history") return;
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();

    const rest = decodeAutomationQueryResponse(
      await json(
        await harness.handler(
          getRequest(
            `/api/automations/history?automationId=${automationId("ae01")}&limit=1&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
          ),
        ),
      ),
    );
    if (rest.kind !== "automation-history") throw new Error("expected history");
    expect(rest.runs).toHaveLength(1);
    expect(String(rest.runs[0]?.id)).not.toBe(String(page.runs[0]?.id));
  });

  it("executes create and run-now commands with the authenticated principal injected", async () => {
    const harness = createHarness();
    const createResponse = await harness.handler(
      postCommand({
        kind: "create-automation",
        automationId: automationId("af01"),
        expectedVersion: 0,
        definition: automationDefinitionDraftFixture(),
      }),
    );
    const created = decodeAutomationCommandResult(await json(createResponse));
    expect(created.kind).toBe("automation-created");
    if (created.kind !== "automation-created") return;
    // The route injects the transport-authenticated window principal, not body data.
    expect(created.automation.createdBy).toEqual({
      kind: "local-window",
      windowId: String(windowId),
      capabilityGeneration: 0,
    });

    const runResponse = await harness.handler(
      postCommand({
        kind: "run-now-automation",
        automationId: automationId("af01"),
        expectedVersion: 1,
        runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
      }),
    );
    const run = decodeAutomationCommandResult(await json(runResponse));
    expect(run.kind).toBe("automation-run-accepted");
  });

  it("rejects command bodies that smuggle principal or origin", async () => {
    const harness = createHarness();
    const withPrincipal = await harness.handler(
      postCommand({
        kind: "create-automation",
        automationId: automationId("b001"),
        expectedVersion: 0,
        principal: localPrincipal,
        definition: automationDefinitionDraftFixture(),
      }),
    );
    expect(withPrincipal?.status).toBe(400);
    const withOrigin = await harness.handler(
      postCommand({
        kind: "run-now-automation",
        automationId: automationId("b001"),
        expectedVersion: 1,
        origin: { kind: "automation-run" },
        runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
      }),
    );
    expect(withOrigin?.status).toBe(400);
  });

  it("denies mutations against unknown or inaccessible Projects before side effects", async () => {
    const harness = createHarness();
    seedInaccessibleAutomation(harness, automationId("b101"));
    const draft = automationDefinitionDraftFixture();

    const foreignCreate = decodeAutomationCommandResult(
      await json(
        await harness.handler(
          postCommand({
            kind: "create-automation",
            automationId: automationId("b102"),
            expectedVersion: 0,
            definition: {
              ...draft,
              projectId: AUTOMATION_TEST_IDS.otherProject,
              binding: { ...draft.binding, projectId: AUTOMATION_TEST_IDS.otherProject },
              executionProfile: {
                ...draft.executionProfile,
                projectId: AUTOMATION_TEST_IDS.otherProject,
              },
            },
          }),
        ),
      ),
    );
    expect(foreignCreate).toMatchObject({
      kind: "automation-command-failed",
      reason: "unauthorized",
    });
    expect(harness.projection.getDefinition(automationId("b102"))).toBeUndefined();

    const foreignPause = decodeAutomationCommandResult(
      await json(
        await harness.handler(
          postCommand({
            kind: "pause-automation",
            automationId: automationId("b101"),
            expectedVersion: 1,
          }),
        ),
      ),
    );
    expect(foreignPause).toMatchObject({
      kind: "automation-command-failed",
      reason: "unauthorized",
    });

    const unknown = decodeAutomationCommandResult(
      await json(
        await harness.handler(
          postCommand({
            kind: "pause-automation",
            automationId: "fa000000-0000-4000-8000-0000000000fe",
            expectedVersion: 1,
          }),
        ),
      ),
    );
    expect(unknown).toMatchObject({ kind: "automation-command-failed", reason: "not-found" });
  });

  it("rejects a remote-device principal from another host and allows the owning host", async () => {
    const harness = createHarness();
    seedAutomation(harness, automationId("b201"));

    const foreignRequest = postCommand({
      kind: "run-now-automation",
      automationId: automationId("b201"),
      expectedVersion: 1,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    });
    bindPrincipalRouteContext(foreignRequest, {
      principal: {
        kind: "remote-device",
        hostId: "other-host" as never,
        deviceId: remoteDeviceId as never,
        credentialGeneration: 1,
        origin: "https://remote.example",
        protocolVersion: 1,
        capabilityDigest: "d".repeat(64),
        sessionId: "00000000-0000-4000-8000-000000000403" as never,
      },
      scopeId: decodeWindowId(remoteDeviceId),
    });
    const denied = await harness.handler(foreignRequest);
    expect(denied?.status).toBe(401);

    const owningRequest = postCommand({
      kind: "run-now-automation",
      automationId: automationId("b201"),
      expectedVersion: 1,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    });
    bindPrincipalRouteContext(owningRequest, {
      principal: {
        kind: "remote-device",
        hostId: "local" as never,
        deviceId: remoteDeviceId as never,
        credentialGeneration: 1,
        origin: "https://remote.example",
        protocolVersion: 1,
        capabilityDigest: "d".repeat(64),
        sessionId: "00000000-0000-4000-8000-000000000403" as never,
      },
      scopeId: decodeWindowId(remoteDeviceId),
    });
    const accepted = decodeAutomationCommandResult(
      await json(await harness.handler(owningRequest)),
    );
    expect(accepted.kind).toBe("automation-run-accepted");

    const foreignRead = getRequest(`/api/automations/get?automationId=${automationId("b201")}`);
    bindPrincipalRouteContext(foreignRead, {
      principal: {
        kind: "remote-device",
        hostId: "other-host" as never,
        deviceId: remoteDeviceId as never,
        credentialGeneration: 1,
        origin: "https://remote.example",
        protocolVersion: 1,
        capabilityDigest: "d".repeat(64),
        sessionId: "00000000-0000-4000-8000-000000000403" as never,
      },
      scopeId: decodeWindowId(remoteDeviceId),
    });
    const deniedRead = await harness.handler(foreignRead);
    expect(deniedRead?.status).toBe(401);
  });

  it("rejects malformed query parameters and oversized command bodies", async () => {
    const harness = createHarness();
    const badMode = await harness.handler(getRequest("/api/automations/list?mode=bogus"));
    expect(badMode?.status).toBe(400);
    const badLimit = await harness.handler(getRequest("/api/automations/list?mode=all&limit=zero"));
    expect(badLimit?.status).toBe(400);
    const badId = await harness.handler(getRequest("/api/automations/get?automationId=nope"));
    expect(badId?.status).toBe(400);
    const unknownParam = await harness.handler(
      getRequest("/api/automations/list?mode=all&extra=1"),
    );
    expect(unknownParam?.status).toBe(400);

    const oversized = await harness.handler(
      new Request("http://127.0.0.1/api/automations/commands", {
        method: "POST",
        headers: {
          "x-octant-window-capability": windowCapability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "create-automation", padding: "x".repeat(1_100_000) }),
      }),
    );
    expect(oversized?.status).toBe(413);
    const notJson = await harness.handler(
      new Request("http://127.0.0.1/api/automations/commands", {
        method: "POST",
        headers: {
          "x-octant-window-capability": windowCapability,
          "content-type": "application/json",
        },
        body: "{not json",
      }),
    );
    expect(notJson?.status).toBe(400);
  });
});
