import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProjectId,
  decodeUtcTimestamp,
  decodeWindowId,
  type ApprovalOutsideContent,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "../persistence/persistenceService";
import { ProjectService } from "../projectService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createProjectMemoryAccess, type ProjectMemoryAccess } from "./projectMemoryAccess";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const hostScope = decodeWindowId("00000000-0000-4000-8000-000000000902");
const deviceScope = decodeWindowId("00000000-0000-4000-8000-000000000903");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000910");
const threadId = "00000000-0000-4000-8000-000000000920";
const taintedThreadId = "00000000-0000-4000-8000-000000000921";
const now = "2026-11-08T10:00:00.000Z";

const marked: ApprovalOutsideContent = {
  sources: [
    {
      sourceLabel: "web-fetch",
      ingestionCount: 1,
      firstIngestedAt: decodeUtcTimestamp(now),
      lastIngestedAt: decodeUtcTimestamp(now),
    },
  ],
  sourceCount: 1,
};

function uuidSequence() {
  let value = 1_000;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function projectServiceFor(persistence: PersistenceService): ProjectService {
  return new ProjectService({
    persistence,
    bindingReceiptStore: { consume: () => ({ canonicalRoot: "/unused" }) } as never,
    projectRootPort: { validate: async (_type, path) => ({ canonicalRoot: path }) },
    uuid: uuidSequence(),
    clock: () => now,
  });
}

function accessFor(persistence: PersistenceService, projects: ProjectService): ProjectMemoryAccess {
  return createProjectMemoryAccess({
    projects,
    readMemory: (id: ProjectId) =>
      persistence.readProject(id) === undefined ? undefined : persistence.readProjectMemory(id),
    isHostScope: (scope: WindowId) => String(scope) === String(hostScope),
    isPairedDeviceScope: (scope: WindowId) => String(scope) === String(deviceScope),
    outsideContent: (id) => (id === taintedThreadId ? marked : undefined),
    uuid: uuidSequence(),
    now: () => Date.parse(now),
  });
}

async function withProject(
  body: (input: {
    readonly persistence: PersistenceService;
    readonly projects: ProjectService;
    readonly access: ProjectMemoryAccess;
  }) => Promise<void>,
  directory = mkdtempSync(join(tmpdir(), "octant-project-memory-tools-")),
  options: { readonly keep?: boolean; readonly create?: boolean } = {},
): Promise<void> {
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const projects = projectServiceFor(persistence);
          if (options.create !== false) {
            yield* Effect.promise(() =>
              projects.executeProject(windowId, {
                kind: "create-chat-project",
                projectId,
                expectedVersion: 0,
                name: "Memory",
                hostId: "local",
              }),
            );
          }
          const access = accessFor(persistence, projects);
          yield* Effect.promise(() => body({ persistence, projects, access }));
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );
  } finally {
    if (options.keep !== true) rmSync(directory, { recursive: true, force: true });
  }
}

function toolsFor(
  access: ProjectMemoryAccess,
  scope: {
    readonly windowId?: WindowId;
    readonly threadId?: string;
    readonly writeRefusal?: () => string | undefined;
  } = {},
): AppManagedToolSet {
  const tools = access.toolsFor({
    windowId: scope.windowId ?? windowId,
    mode: "code",
    threadId: scope.threadId ?? threadId,
    projectId: String(projectId),
    ...(scope.writeRefusal === undefined ? {} : { writeRefusal: scope.writeRefusal }),
  });
  if (tools === undefined) throw new Error("Expected the memory tool");
  return tools;
}

function call(tools: AppManagedToolSet, input: unknown) {
  return tools.execute({ name: "octant_memory", inputJson: JSON.stringify(input) });
}

async function waitingProposal(access: ProjectMemoryAccess) {
  await vi.waitFor(() => expect(access.proposals.list(windowId)).toHaveLength(1));
  const [proposal] = access.proposals.list(windowId);
  if (proposal === undefined) throw new Error("Expected a waiting proposal");
  return proposal;
}

describe("octant_memory", () => {
  it("offers no tool to a thread outside a Project", async () => {
    await withProject(async ({ access }) => {
      expect(
        access.toolsFor({ windowId, mode: "chat", threadId, projectId: undefined }),
      ).toBeUndefined();
    });
  });

  it("writes an approved entry marked with the thread it came from, and replays it unchanged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-memory-tools-"));
    try {
      await withProject(
        async ({ access }) => {
          const tools = toolsFor(access);
          const pending = call(tools, {
            operation: "create",
            memoryKind: "decision",
            content: "Releases ship from main only.",
          });
          const proposal = await waitingProposal(access);
          expect(proposal).toMatchObject({
            projectId,
            mode: "code",
            threadId,
            expectedVersion: 0,
            change: { kind: "create", memoryKind: "decision" },
          });
          expect(proposal.outsideContent).toBeUndefined();
          await expect(
            access.proposals.decide(windowId, {
              proposalId: proposal.proposalId,
              decision: "confirm",
            }),
          ).resolves.toMatchObject({ kind: "project-memory-proposal-confirmed" });
          await expect(pending).resolves.toMatchObject({ result: { status: "confirmed" } });
          const listed = await call(tools, { operation: "list" });
          expect(listed.result).toMatchObject({
            entries: [
              {
                content: "Releases ship from main only.",
                writtenBy: "an agent, approved by the person",
              },
            ],
          });
        },
        directory,
        { keep: true },
      );
      await withProject(
        async ({ persistence }) => {
          expect(persistence.readProjectMemory(projectId).active).toMatchObject([
            {
              content: "Releases ship from main only.",
              provenance: { kind: "agent-authored", mode: "code", threadId },
              author: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            },
          ]);
        },
        directory,
        { create: false },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a write in Plan mode without asking the person, and still lists", async () => {
    await withProject(async ({ access, persistence }) => {
      const tools = toolsFor(access, { writeRefusal: () => "Plan mode cannot change memory." });
      await expect(
        call(tools, { operation: "create", memoryKind: "fact", content: "Not in Plan." }),
      ).resolves.toMatchObject({
        isError: true,
        result: { status: "refused", reason: "plan-mode" },
      });
      expect(access.proposals.list(windowId)).toEqual([]);
      await expect(call(tools, { operation: "list" })).resolves.toMatchObject({
        result: { entries: [] },
      });
      expect(persistence.readProjectMemory(projectId).active).toEqual([]);
    });
  });

  it("tells the agent the person declined and leaves memory unchanged", async () => {
    await withProject(async ({ access, persistence }) => {
      const pending = call(toolsFor(access), {
        operation: "create",
        memoryKind: "fact",
        content: "Declined text.",
      });
      const proposal = await waitingProposal(access);
      await expect(
        access.proposals.decide(windowId, { proposalId: proposal.proposalId, decision: "decline" }),
      ).resolves.toEqual({ kind: "project-memory-proposal-declined" });
      await expect(pending).resolves.toMatchObject({ result: { status: "declined" } });
      expect(persistence.readProjectMemory(projectId).active).toEqual([]);
    });
  });

  it("asks for every write on a thread that read outside content and names what it read", async () => {
    await withProject(async ({ access }) => {
      const tools = toolsFor(access, { threadId: taintedThreadId });
      const first = call(tools, { operation: "create", memoryKind: "fact", content: "One." });
      const proposal = await waitingProposal(access);
      expect(proposal.outsideContent).toEqual(marked);
      await access.proposals.decide(windowId, {
        proposalId: proposal.proposalId,
        decision: "confirm",
      });
      await expect(first).resolves.toMatchObject({ result: { status: "confirmed" } });
      // A confirmed write lends nothing to the next one: it waits again.
      const second = call(tools, { operation: "create", memoryKind: "fact", content: "Two." });
      const next = await waitingProposal(access);
      expect(next.outsideContent).toEqual(marked);
      await access.proposals.decide(windowId, { proposalId: next.proposalId, decision: "decline" });
      await expect(second).resolves.toMatchObject({ result: { status: "declined" } });
    });
  });

  it("refuses writes from a turn with nobody at a window on this computer", async () => {
    await withProject(async ({ access }) => {
      for (const scope of [hostScope, deviceScope]) {
        await expect(
          call(toolsFor(access, { windowId: scope }), {
            operation: "retract",
            entryId: "00000000-0000-4000-8000-000000000999",
            reason: "Stale.",
          }),
        ).resolves.toMatchObject({ result: { reason: "nobody-to-confirm" } });
        expect(access.proposals.list(scope)).toEqual([]);
      }
    });
  });

  it("does not apply a confirmed change made against memory that changed while it waited", async () => {
    await withProject(async ({ access, projects }) => {
      const pending = call(toolsFor(access), {
        operation: "create",
        memoryKind: "fact",
        content: "Raced.",
      });
      const proposal = await waitingProposal(access);
      await projects.executeMemory({
        kind: "create-memory-entry",
        projectId,
        entryId: "00000000-0000-4000-8000-000000000930",
        memoryKind: "fact",
        content: "Written by the person meanwhile.",
        expectedVersion: 0,
      });
      await expect(
        access.proposals.decide(windowId, { proposalId: proposal.proposalId, decision: "confirm" }),
      ).resolves.toMatchObject({ kind: "project-memory-proposal-not-applied" });
      await expect(pending).resolves.toMatchObject({
        isError: true,
        result: { status: "not-applied", message: "Project memory changed; reload and retry." },
      });
    });
  });

  it("does not apply a confirmed change to a Project archived while it waited", async () => {
    await withProject(async ({ access, projects }) => {
      const pending = call(toolsFor(access), {
        operation: "create",
        memoryKind: "fact",
        content: "Too late.",
      });
      const proposal = await waitingProposal(access);
      await projects.executeProject(windowId, {
        kind: "change-project-lifecycle",
        projectId,
        expectedVersion: 1,
        lifecycle: "archived",
      });
      await access.proposals.decide(windowId, {
        proposalId: proposal.proposalId,
        decision: "confirm",
      });
      await expect(pending).resolves.toMatchObject({
        result: { status: "not-applied", message: "Archived Projects are read-only." },
      });
    });
  });

  it("supersedes and retracts only entries that are active, and only after confirmation", async () => {
    await withProject(async ({ access, persistence, projects }) => {
      const created = await projects.executeMemory({
        kind: "create-memory-entry",
        projectId,
        entryId: "00000000-0000-4000-8000-000000000940",
        memoryKind: "preference",
        content: "Tabs.",
        expectedVersion: 0,
      });
      const tools = toolsFor(access);
      await expect(
        call(tools, {
          operation: "supersede",
          entryId: "00000000-0000-4000-8000-000000000941",
          content: "Spaces.",
        }),
      ).resolves.toMatchObject({ result: { reason: "entry-not-found" } });
      const pending = call(tools, {
        operation: "supersede",
        entryId: String(created.entry.id),
        content: "Spaces.",
      });
      const proposal = await waitingProposal(access);
      expect(proposal.change).toMatchObject({ kind: "supersede", previousContent: "Tabs." });
      await access.proposals.decide(windowId, {
        proposalId: proposal.proposalId,
        decision: "confirm",
      });
      await expect(pending).resolves.toMatchObject({ result: { status: "confirmed" } });
      expect(persistence.readProjectMemory(projectId)).toMatchObject({
        active: [{ content: "Spaces.", provenance: { kind: "agent-authored", threadId } }],
        history: [
          { content: "Tabs.", status: "superseded", provenance: { kind: "user-authored" } },
        ],
      });
    });
  });
});
