import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasId,
  decodeCanvasVersion,
  type UtcTimestamp,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { canvasChoiceQuestionFingerprint } from "@octant/domain";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  CanvasChoiceAnswerService,
  registerCanvasChoiceAnswerEvents,
} from "./canvasChoiceAnswerService";
import { CanvasProjection } from "./canvasProjection";

const directories: Array<string> = [];
const now = "2026-11-12T10:00:00.000Z" as UtcTimestamp;

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
} as const;
const canvasId = decodeCanvasId(ids.canvas);
const actor = { kind: "local-user", actorId: ids.actor } as const;
const agent = { kind: "agent", actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as const;
const eventActor = Schema.decodeUnknownSync(EventActor)(actor);
const context = { mode: "chat", projectId: ids.project } as const;
const project = { id: ids.project, type: "chat", lifecycle: "active" } as const;

const questions = Array.from({ length: 24 }, (_, n) => ({
  id: `q${String(n)}`,
  prompt: `Decision ${String(n)}`,
  selection: "single" as const,
  options: [
    { id: "yes", label: "Yes", recommended: true },
    { id: "no", label: "No" },
  ],
}));
const questionFingerprint = (id: string) => {
  const question = questions.find((candidate) => candidate.id === id);
  if (question === undefined) throw new Error("fixture");
  return canvasChoiceQuestionFingerprint(question);
};
const set = (id: string, option = "yes") => ({
  kind: "set",
  blockId: "decisions",
  questionId: id,
  questionFingerprint: questionFingerprint(id),
  selectedOptionIds: [option],
});
const revise = (expectedSequence: number, changes: ReadonlyArray<unknown>) => ({
  kind: "canvas-choice-answers-revise",
  canvasId: ids.canvas,
  expectedSequence,
  changes,
});

function fixture(authorize: () => boolean = () => true) {
  const projection = new CanvasProjection();
  projection.applyCreated({
    canvasId,
    version: decodeCanvasVersion({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      definition: {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: "Decisions",
        provenance: {
          mode: "chat",
          hostId: "local",
          projectId: ids.project,
          threadId: ids.thread,
          actor: agent,
          providerInstanceId: ids.provider,
          modelId: "octant-test-model",
          createdAt: now,
        },
        sourceManifest: [],
        blocks: [
          {
            blockId: "decisions",
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "choice",
            prompt: "Twenty-four decisions",
            questions,
          },
        ],
      },
      createdBy: agent,
      createdAt: now,
    }),
  });
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-answers-"));
  directories.push(directory);
  const connection: SqliteConnection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const journal = new Journal({
    connection,
    registry: registerCanvasChoiceAnswerEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${(++counter).toString(16).padStart(12, "0")}`;
  const service = () =>
    new CanvasChoiceAnswerService(
      { journal, projection, uuid, actor: eventActor, now: () => now },
      { authorize },
    );
  return { service };
}

describe("CanvasChoiceAnswerService", () => {
  it("saves a long form's answers as the host's own and rebuilds them after a restart", () => {
    const { service } = fixture();
    const first = service();
    expect(first.revise(revise(0, [set("q0")]), context, project)).toEqual({
      kind: "accepted",
      canvasId,
      sequence: 1,
    });
    // Accepting recommendations is one batch over the rest.
    expect(
      first.revise(
        revise(
          1,
          questions.slice(1).map((question) => set(question.id)),
        ),
        context,
        project,
      ),
    ).toMatchObject({ kind: "accepted", sequence: 24 });

    const outcome = service().answers(canvasId, context, project);
    expect(outcome).toMatchObject({ kind: "ready", sequence: 24 });
    if (outcome.kind !== "ready") return;
    expect(outcome.answers).toHaveLength(24);
    expect(outcome.answers.every((answer) => answer.author.kind === "local-user")).toBe(true);
  });

  it("refuses a change against an old sequence and one for a question that changed", () => {
    const { service } = fixture();
    const current = service();
    current.revise(revise(0, [set("q0")]), context, project);
    expect(current.revise(revise(0, [set("q1")]), context, project)).toMatchObject({
      kind: "denied",
      denialCode: "stale-version",
    });
    expect(
      current.revise(revise(1, [{ ...set("q1"), questionFingerprint: "old" }]), context, project),
    ).toMatchObject({ kind: "denied", denialCode: "question-changed" });
    expect(current.answers(canvasId, context, project)).toMatchObject({ sequence: 1 });
  });

  it("names the host's person as the author whatever the request says, and keeps a refused batch out", () => {
    const { service } = fixture();
    const current = service();
    const forged = { ...set("q0"), author: agent };
    expect(current.revise(revise(0, [forged]), context, project)).toMatchObject({
      kind: "denied",
      denialCode: "malformed-request",
    });
    expect(
      current.revise(revise(0, [set("q0"), set("q1", "maybe")]), context, project),
    ).toMatchObject({ kind: "denied", denialCode: "invalid-answer" });
    expect(current.answers(canvasId, context, project)).toMatchObject({
      sequence: 0,
      answers: [],
    });
  });

  it("returns no answers, and takes none, for a workspace that may not use the Canvas", () => {
    const { service } = fixture(() => false);
    const current = service();
    expect(current.answers(canvasId, context, project)).toEqual({
      kind: "unauthorized",
      canvasId,
    });
    expect(current.revise(revise(0, [set("q0")]), context, project)).toMatchObject({
      kind: "denied",
      denialCode: "unauthorized",
    });
  });
});
