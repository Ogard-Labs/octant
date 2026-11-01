import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_FLOW_AGGREGATE_TYPE,
  decodeEventActor,
  decodeProjectId,
  MAX_BROWSER_FLOWS_PER_PROJECT,
  type BrowserFlowStep,
  type Project,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedProjectData } from "../persistence/threadPurge";
import { BrowserFlowRecorder, BrowserFlowService } from "./browserFlows";

const now = "2026-11-01T09:00:00.000Z";
const projectA = decodeProjectId("d0000000-0000-4000-8000-00000000000a");
const projectB = decodeProjectId("d0000000-0000-4000-8000-00000000000b");
const person = decodeEventActor({
  kind: "local-user",
  actorId: "d0000000-0000-4000-8000-0000000000ff",
});
const agent = decodeEventActor({
  kind: "agent",
  actorId: "d0000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "d0000000-0000-4000-8000-0000000000aa",
  threadId: "d0000000-0000-4000-8000-0000000000bb",
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function open() {
  const directory = mkdtempSync(join(tmpdir(), "octant-browser-flows-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let tick = 0;
  const service = () =>
    new BrowserFlowService({
      journal,
      connection,
      readProject: (id) =>
        String(id) === String(projectA) ? ({ name: "Docs site" } as Project) : undefined,
      personActor: person,
      uuid: randomUUID,
      clock: () => new Date(Date.parse(now) + ++tick * 1_000).toISOString(),
    });
  return { connection, journal, service };
}

const step = (operation: string, input: Record<string, unknown>, path = "/"): BrowserFlowStep => ({
  operation,
  input: { operation, ...input },
  expect: { path, title: "Page" },
});
const openAndClick = [
  step("navigate", { url: "http://127.0.0.1:8080/form" }, "/form"),
  step("click", {}, "/form"),
];

describe("a Project's saved Browser flows", () => {
  it("saves, lists, replaces, and deletes a flow by name", () => {
    const { service } = open();
    const flows = service();
    expect(flows.list(projectA)).toEqual([]);
    expect(
      flows.save({ projectId: projectA, name: "Check form", steps: openAndClick, actor: agent }),
    ).toEqual({ status: "saved", replaced: false });
    expect(
      flows.save({
        projectId: projectA,
        name: "Check form",
        steps: [openAndClick[0]!],
        actor: agent,
      }),
    ).toEqual({ status: "saved", replaced: true });
    expect(flows.list(projectA).map((flow) => [flow.name, flow.steps.length])).toEqual([
      ["Check form", 1],
    ]);
    expect(flows.list(projectB)).toEqual([]);
    expect(flows.delete(projectA, "Missing")).toBe(false);
    expect(flows.delete(projectA, "Check form")).toBe(true);
    expect(flows.list(projectA)).toEqual([]);
  });

  it("rebuilds the same flows from the journal after a restart", () => {
    const { service } = open();
    const first = service();
    first.save({ projectId: projectA, name: "One", steps: openAndClick, actor: agent });
    first.save({ projectId: projectA, name: "Two", steps: openAndClick, actor: agent });
    first.save({ projectId: projectA, name: "One", steps: [openAndClick[0]!], actor: agent });
    first.delete(projectA, "Two");
    const restarted = service();
    expect(restarted.list(projectA).map((flow) => [flow.name, flow.steps.length])).toEqual([
      ["One", 1],
    ]);
  });

  it("journals the save as the agent and the delete as the person, with no page text", () => {
    const { service, journal } = open();
    const flows = service();
    flows.save({ projectId: projectA, name: "One", steps: openAndClick, actor: agent });
    flows.delete(projectA, "One");
    const events = journal.replayAggregate({
      aggregateType: BROWSER_FLOW_AGGREGATE_TYPE,
      aggregateId: String(projectA),
      afterVersion: 0,
      limit: 10,
    });
    expect(events.map((event) => [event.eventName, event.actor.kind])).toEqual([
      ["browser.flow-saved@1", "agent"],
      ["browser.flow-deleted@1", "local-user"],
    ]);
  });

  it("summarizes flows across Projects with their step count and first address", () => {
    const { service } = open();
    const flows = service();
    flows.save({ projectId: projectA, name: "Check form", steps: openAndClick, actor: agent });
    flows.save({
      projectId: projectB,
      name: "Other",
      steps: [step("scroll", { deltaY: 10 })],
      actor: agent,
    });
    expect(
      flows
        .summaries()
        .map((entry) => [entry.projectLabel, entry.name, entry.stepCount, entry.firstAddress]),
    ).toEqual([
      ["A Project that no longer exists", "Other", 1, undefined],
      ["Docs site", "Check form", 2, "http://127.0.0.1:8080/form"],
    ]);
  });

  it("refuses a flow past the Project's limit or size, but still replaces one by name", () => {
    const { service } = open();
    const flows = service();
    for (let index = 0; index < MAX_BROWSER_FLOWS_PER_PROJECT; index += 1) {
      flows.save({
        projectId: projectA,
        name: `Flow ${String(index)}`,
        steps: openAndClick,
        actor: agent,
      });
    }
    expect(
      flows.save({ projectId: projectA, name: "One too many", steps: openAndClick, actor: agent }),
    ).toEqual({
      status: "refused",
      reason: "flow-store-full",
    });
    expect(
      flows.save({ projectId: projectA, name: "Flow 3", steps: openAndClick, actor: agent }).status,
    ).toBe("saved");
    const huge = [step("type", { text: "x".repeat(60_000) })];
    expect(
      flows.save({
        projectId: projectB,
        name: "Huge",
        steps: Array.from({ length: 6 }, () => huge[0]!),
        actor: agent,
      }),
    ).toEqual({ status: "refused", reason: "flow-too-large" });
  });
});

describe("erasing a Project", () => {
  it("takes its saved flows with its other data and leaves other Projects' flows", () => {
    const { service, connection } = open();
    const flows = service();
    flows.save({ projectId: projectA, name: "One", steps: openAndClick, actor: agent });
    flows.save({ projectId: projectB, name: "Kept", steps: openAndClick, actor: agent });
    erasePurgedProjectData({ connection, projectId: String(projectA), canvasIds: [] });
    flows.forget(projectA);
    expect(flows.list(projectA)).toEqual([]);
    expect(service().list(projectA)).toEqual([]);
    expect(
      service()
        .list(projectB)
        .map((flow) => flow.name),
    ).toEqual(["Kept"]);
  });
});

describe("the run the recorder keeps for a page", () => {
  it("keeps at most 50 steps, remembers what needs a person, and forgets a stopped page", () => {
    const recorder = new BrowserFlowRecorder();
    for (let index = 0; index < 52; index += 1)
      recorder.record("page", step("scroll", { deltaY: 1 }));
    expect(recorder.read("page")).toMatchObject({ overflowed: true, blockedBy: undefined });
    expect(recorder.read("page")?.steps).toHaveLength(50);
    recorder.block("page", "upload");
    recorder.block("page", "sign-in");
    expect(recorder.read("page")?.blockedBy).toBe("upload");
    recorder.forget("page");
    expect(recorder.read("page")).toBeUndefined();
  });
});
