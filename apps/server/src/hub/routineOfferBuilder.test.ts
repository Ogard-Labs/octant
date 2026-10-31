import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { decodeHubOfferBody, type RoutineOffer } from "@octant/contracts";
import type { AgentProfile } from "@octant/contracts/agent-profile";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { AutomationCommandService } from "../automation/automationCommandService";
import { AutomationEventStore, registerAutomationEvents } from "../automation/automationEventStore";
import { AutomationProjection } from "../automation/automationProjection";
import { AUTOMATION_TEST_IDS, AUTOMATION_TEST_NOW } from "../automation/automationTestFixtures";
import { createRoutineOfferAuthor, type RoutineOfferDependencies } from "./routineOfferBuilder";

const directories: Array<string> = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const PROJECT_ID = AUTOMATION_TEST_IDS.project;
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let counter = 0;
const uuid = () => `ce000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const profile = {
  id: AUTOMATION_TEST_IDS.executionProfile,
  displayName: "Careful",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  compatibleModes: ["work"],
  version: 1,
  createdAt: AUTOMATION_TEST_NOW,
  updatedAt: AUTOMATION_TEST_NOW,
} as unknown as AgentProfile;

const offer = decodeHubOfferBody({
  kind: "routine",
  displayName: "Morning review",
  taskPrompt: "Summarise what changed overnight.",
  mode: "work",
  trigger: { kind: "interval", anchorAt: "2026-11-01T08:00:00.000Z", intervalMinutes: 1_440 },
}) as RoutineOffer;

function host(overrides: Partial<RoutineOfferDependencies> = {}, commands: Array<string> = []) {
  const directory = mkdtempSync(join(tmpdir(), "octant-routine-offer-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => AUTOMATION_TEST_NOW);
  const projection = new AutomationProjection();
  const journal = new Journal({
    connection,
    registry: registerAutomationEvents(new EventRegistry()),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => AUTOMATION_TEST_NOW,
  });
  const automations = new AutomationCommandService({
    store: new AutomationEventStore({ journal, uuid, actor }),
    projection,
    hostId: "local",
    clock: () => AUTOMATION_TEST_NOW,
  });
  const author = createRoutineOfferAuthor({
    hostId: "local",
    actorId: AUTOMATION_TEST_IDS.actor,
    authorScopeId: "host-scope",
    workProject: (projectId) =>
      projectId === PROJECT_ID
        ? {
            projectId,
            name: "Notes",
            projectVersion: 1,
            bindingRevisionId: AUTOMATION_TEST_IDS.bindingRevision,
          }
        : undefined,
    profiles: async () => [profile],
    workModel: () => ({
      instanceId: AUTOMATION_TEST_IDS.providerInstance,
      modelId: "approved-model",
    }),
    automations: {
      execute: (command) => {
        commands.push(command.kind);
        return automations.execute(command);
      },
    },
    uuid,
    clock: () => AUTOMATION_TEST_NOW,
    ...overrides,
  });
  return { author, projection };
}

describe("a routine the hub offered, built on this host", () => {
  it("becomes a paused, approval-gated Work routine bound to the Project the person named", async () => {
    const { author, projection } = host();

    expect(await author(offer, PROJECT_ID)).toEqual({ status: "applied" });

    const [created] = projection.listDefinitions();
    expect(created).toMatchObject({
      displayName: "Morning review",
      mode: "work",
      lifecycle: "paused",
      nextDueAt: null,
      projectId: PROJECT_ID,
      executionProfile: { executionPolicy: "approval-gated" },
      authorityProfile: {
        effective: { shell: true, git: true, executionPolicy: "approval-gated" },
      },
    });
  });

  it("is journaled paused from its first event, with no later pause step", async () => {
    const commands: Array<string> = [];
    const { author, projection } = host({}, commands);

    await author(offer, PROJECT_ID);

    expect(commands).toEqual(["create-automation"]);
    expect(projection.listDefinitions()[0]).toMatchObject({ lifecycle: "paused", version: 1 });
  });

  it("is refused for a Project this host does not hold as an active Work Project, and makes nothing", async () => {
    const { author, projection } = host();

    expect(await author(offer, "aa000000-0000-4000-8000-0000000000ff")).toEqual({
      status: "failed",
      kind: "apply-failed",
    });
    expect(projection.listDefinitions()).toEqual([]);
  });

  it("is refused when no approval-gated profile or no Work model exists, rather than widening authority", async () => {
    const noProfile = host({ profiles: async () => [] });
    const noModel = host({ workModel: () => undefined });

    expect(await noProfile.author(offer, PROJECT_ID)).toEqual({
      status: "failed",
      kind: "apply-failed",
    });
    expect(await noModel.author(offer, PROJECT_ID)).toEqual({
      status: "failed",
      kind: "apply-failed",
    });
    expect(noProfile.projection.listDefinitions()).toEqual([]);
  });

  it("is refused for a Code routine, whose checkout only a window has prepared", async () => {
    const { author } = host();
    const codeOffer = { ...offer, mode: "code" } as RoutineOffer;

    expect(await author(codeOffer, PROJECT_ID)).toEqual({
      status: "failed",
      kind: "kind-unsupported",
    });
  });
});
