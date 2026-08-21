import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeWorkAttachmentId,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  decodeProjectId,
  decodeProviderInstance,
  decodeWindowId,
  type Project,
  type UtcTimestamp,
} from "@octant/contracts";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { WorkAttachmentStore } from "./workAttachmentStore";
import { WorkTurnProjection } from "./workTurnProjection";
import {
  WorkTurnService,
  WorkTurnServiceError,
  type WorkTurnServiceDependencies,
} from "./workTurnService";
import type { WorkTurnRuntimePort } from "./workTurnRuntime";

const attachmentRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    attachmentRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const now = "2026-08-11T12:00:00.000Z" as UtcTimestamp;
const ids = {
  window: decodeWindowId("72000000-0000-4000-8000-000000000001"),
  project: decodeProjectId("72000000-0000-4000-8000-000000000002"),
  thread: decodeWorkThreadId("72000000-0000-4000-8000-000000000004"),
  provider: "72000000-0000-4000-8000-000000000005",
  binding: "72000000-0000-4000-8000-000000000008",
  request: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  turn: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  session: "11111111-1111-4111-8111-111111111111",
} as const;

describe("WorkTurnService", () => {
  it("validates host, Project, binding, working directory, and confinement before launching", async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.turn.capabilities.code).toBe("denied");
    expect(result.turn.transcript[0]).toEqual({
      role: "user",
      text: "Summarize the brief",
    });
    await fixture.waitForIdle();
    expect(fixture.acquireInputs[0]).toMatchObject({
      mode: "work",
      workRequest: {
        projectId: ids.project,
        threadId: ids.thread,
      },
    });
    const lookup = await fixture.service.lookupFirstTurn(ids.window, ids.request);
    expect(lookup).toMatchObject({
      kind: "accepted",
      turn: expect.objectContaining({
        status: "completed",
        response: "Provider reply",
      }),
    });
  });

  it("preserves draft semantics by rejecting a stale binding without creating a turn", async () => {
    const fixture = serviceFixture({
      project: {
        ...workProject(),
        bindingHistory: [
          {
            revisionId: "99999999-9999-4999-8999-999999999999" as never,
            revision: 2,
            currentBinding: { canonicalRoot: "/private/tmp/knowledge" },
            actor: {
              kind: "local-user",
              actorId: "72000000-0000-4000-8000-000000000009" as never,
            },
            changedAt: now as never,
          },
        ],
      } as Project,
    });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toEqual(
      new WorkTurnServiceError({
        category: "stale",
        message: "Work Project binding changed; reload and retry.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("cancels an in-flight turn and keeps the durable transcript recoverable", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial reply");
          await gate.promise;
          if (input.signal.aborted) return { kind: "cancelled" };
          return { kind: "completed", response: "Partial reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const cancelled = await fixture.service.cancelFirstTurn(ids.window, {
      kind: "cancel-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    });
    expect(cancelled.kind).toBe("turn-cancelled");
    gate.resolve();
    await fixture.waitForIdle();
    const transcript = await fixture.service.transcript(ids.window, ids.thread);
    expect(transcript.turns[0]?.status).toBe("cancelled");
  });

  it("sends a staged image to the provider and refuses a text-only model", async () => {
    const store = await attachmentStore();
    const attachmentId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000001");
    const bytes = new Uint8Array([137, 80, 78]);
    const sent: Array<ReadonlyArray<{ readonly attachmentId: string }>> = [];
    const fixture = serviceFixture({
      attachments: store,
      supportsAttachments: () => true,
      turnRuntime: {
        run: async (input) => {
          sent.push(input.attachments ?? []);
          return { kind: "completed", response: "Saw the mockup" };
        },
      },
    });
    await fixture.service.stageAttachment(ids.window, {
      threadId: ids.thread,
      attachmentId,
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes,
    });

    const result = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      prompt: "Match this mockup",
      attachmentIds: [attachmentId],
    });
    expect(result.kind).toBe("accepted");
    await fixture.waitForIdle();
    expect(sent[0]?.[0]?.attachmentId).toBe(String(attachmentId));
    expect(sent[0]?.[0]).toMatchObject({ displayName: "mockup.png", mediaType: "image/png" });

    const refusedStore = await attachmentStore();
    const refusedId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000002");
    const refused = serviceFixture({
      attachments: refusedStore,
      supportsAttachments: () => false,
    });
    await refused.service.stageAttachment(ids.window, {
      threadId: ids.thread,
      attachmentId: refusedId,
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes,
    });
    await expect(
      refused.service.startFirstTurn(ids.window, {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"),
        prompt: "Match this mockup",
        attachmentIds: [refusedId],
      }),
    ).rejects.toEqual(
      new WorkTurnServiceError({
        category: "unsupported",
        message:
          "The selected model does not support images. Choose a vision model, or remove the attachments.",
      }),
    );
    expect(refused.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("does not send a discarded image on a later turn", async () => {
    const store = await attachmentStore();
    const attachmentId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000003");
    const fixture = serviceFixture({
      attachments: store,
      supportsAttachments: () => true,
    });
    await fixture.service.stageAttachment(ids.window, {
      threadId: ids.thread,
      attachmentId,
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await fixture.service.discardAttachment(ids.window, ids.thread, attachmentId);
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        prompt: "Never mind the picture",
        attachmentIds: [attachmentId],
      }),
    ).rejects.toEqual(
      new WorkTurnServiceError({
        category: "invalid",
        message: "An image attached to this turn is no longer staged.",
      }),
    );
  });

  it("carries the prior transcript on a follow-up turn", async () => {
    const sent: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          sent.push(input.context ?? []);
          return { kind: "completed", response: "Revised summary" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    const followUp = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"),
      turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"),
      prompt: "Revise that",
    });
    expect(followUp.kind).toBe("accepted");
    await fixture.waitForIdle(decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"));
    expect(sent[1]).toEqual([
      { kind: "user-message", text: "Summarize the brief" },
      { kind: "assistant-message", text: "Revised summary" },
    ]);
  });

  it("refuses a turn whose mentioned files cannot fit the context budget", async () => {
    const fixture = serviceFixture({
      safeInputBudgetTokens: 50,
      resolveFileMentionContext: async () => [
        { kind: "user-message" as const, text: "a".repeat(8_000) },
      ],
    });
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        fileMentionPaths: ["notes.md"],
      }),
    ).rejects.toEqual(
      new WorkTurnServiceError({
        category: "invalid",
        message:
          "Mentioned files and prior Work context exceed the model's input budget. Remove a file mention or start a new thread.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("resumes durable transcript after reconnect through lookup and thread bootstrap", async () => {
    const fixture = serviceFixture();
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    const lookup = await fixture.service.lookupFirstTurn(ids.window, ids.request);
    const transcript = await fixture.service.transcript(ids.window, ids.thread);
    expect(lookup).toMatchObject({ kind: "accepted", turn: { status: "completed" } });
    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.transcript).toEqual([
      { role: "user", text: "Summarize the brief" },
      { role: "assistant", text: "Provider reply", status: "completed" },
    ]);
  });

  it("hands a follow-up turn the prior transcript as provider context", async () => {
    const run = vi.fn();
    run.mockImplementationOnce(async () => ({
      kind: "completed" as const,
      response: "Provider reply",
    }));
    run.mockImplementation(async () => ({ kind: "completed" as const, response: "Shorter." }));
    const fixture = serviceFixture({ turnRuntime: { run } });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();

    const followUp = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      prompt: "Make that summary shorter",
    });
    expect(followUp.kind).toBe("accepted");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      command: expect.objectContaining({ prompt: "Make that summary shorter" }),
      context: [
        { kind: "user-message", text: "Summarize the brief" },
        { kind: "assistant-message", text: "Provider reply" },
      ],
    });
  });
});

function startCommand() {
  return {
    kind: "start-work-thread-turn",
    requestId: ids.request,
    threadId: ids.thread,
    turnId: ids.turn,
    prompt: "Summarize the brief",
    authority: {
      hostId: "local",
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: ids.provider,
      modelId: "model-a",
    },
  };
}

async function attachmentStore(): Promise<WorkAttachmentStore> {
  const root = await mkdtemp(join(tmpdir(), "octant-work-turn-attachment-"));
  attachmentRoots.push(root);
  return new WorkAttachmentStore(root);
}

function serviceFixture(
  options: {
    readonly project?: Project;
    readonly turnRuntime?: WorkTurnRuntimePort;
    readonly attachments?: WorkAttachmentStore;
    readonly supportsAttachments?: () => boolean;
    readonly safeInputBudgetTokens?: number;
    readonly resolveFileMentionContext?: WorkTurnServiceDependencies["resolveFileMentionContext"];
  } = {},
) {
  const projection = new WorkTurnProjection();
  const acquireInputs: unknown[] = [];
  const defaultDriver: ProviderDriver = {
    kind: "openai-compatible",
    probe: () => Effect.die("unused"),
    acquire: (input) => {
      acquireInputs.push(input);
      return Effect.succeed({
        events: Stream.empty,
        start: () => Effect.void,
        send: () => Effect.void,
        resume: () => Effect.void,
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      } as never);
    },
  };
  const defaultRuntime: WorkTurnRuntimePort = {
    run: async (input) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* input.driver.acquire({
              instanceId: input.command.authority.providerInstanceId,
              projectRoot: input.projectRoot,
              mode: "work",
              workRequest: {
                projectId: input.command.authority.projectId,
                threadId: input.command.threadId,
                sessionId: input.providerSessionId,
              },
            });
            yield* connection.start({
              sessionId: input.providerSessionId,
              modelId: input.command.authority.modelId,
              executionPolicy: "approval-gated",
            });
          }),
        ),
      );
      if (input.signal.aborted) return { kind: "cancelled" };
      input.onDelta?.("Provider reply");
      if (input.signal.aborted) return { kind: "cancelled" };
      return { kind: "completed", response: "Provider reply" };
    },
  };
  const persistence = {
    status: () => ({ state: "current", integrity: "ok" }),
    readProject: vi.fn(() => options.project ?? workProject()),
    readProviderInstance: vi.fn(() =>
      decodeProviderInstance({
        id: ids.provider,
        displayName: "Test",
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://example.invalid/v1/",
          authentication: "bearer",
          protocol: "responses",
          manualModelIds: ["model-a"],
        },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ),
    journal: {
      append: vi.fn(),
    },
  };
  const threads = {
    bootstrap: vi.fn(async () => ({
      threads: [
        decodeWorkThread({
          id: ids.thread,
          projectId: ids.project,
          title: "Draft brief",
          lifecycle: "active",
          providerInstanceId: ids.provider,
          modelId: "model-a",
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ],
    })),
  };
  const projects = {
    bootstrap: vi.fn(async () => ({
      active: [{ id: ids.project, type: "work", lifecycle: "active" }],
    })),
  };
  const service = new WorkTurnService({
    persistence: persistence as never,
    threads: threads as never,
    projects: projects as never,
    projection,
    workingDirectories: {
      resolve: vi.fn(async (root: string) => root),
    },
    resolveDriver: () => defaultDriver,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.supportsAttachments === undefined
      ? {}
      : { supportsAttachments: options.supportsAttachments }),
    turnRuntime: options.turnRuntime ?? defaultRuntime,
    ...(options.safeInputBudgetTokens === undefined
      ? {}
      : { safeInputBudgetTokens: options.safeInputBudgetTokens }),
    ...(options.resolveFileMentionContext === undefined
      ? {}
      : { resolveFileMentionContext: options.resolveFileMentionContext }),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n === 1 ? ids.session : `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      };
    })(),
    clock: () => now,
  });

  const waitForIdle = async (requestId = ids.request) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const turn = projection.lookup(requestId);
      if (
        turn !== undefined &&
        (turn.status === "completed" ||
          turn.status === "cancelled" ||
          turn.status === "failed" ||
          turn.status === "waiting")
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  return { service, persistence, projection, acquireInputs, waitForIdle };
}

function workProject(): Project {
  return {
    id: ids.project,
    type: "work",
    name: "Knowledge",
    lifecycle: "active",
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
    binding: { canonicalRoot: "/private/tmp/knowledge" },
    bindingHistory: [
      {
        revisionId: ids.binding as never,
        revision: 1,
        currentBinding: { canonicalRoot: "/private/tmp/knowledge" },
        actor: {
          kind: "local-user",
          actorId: "72000000-0000-4000-8000-000000000009" as never,
        },
        changedAt: now as never,
      },
    ],
  } as Project;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
