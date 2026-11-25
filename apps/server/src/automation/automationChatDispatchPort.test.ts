import { describe, expect, it, vi } from "vitest";
import type {
  AutomationDefinition,
  AutomationRun,
  ChatThreadId,
  UtcTimestamp,
} from "@octant/contracts";
import { automationFollowUpTurnPrompt } from "@octant/contracts";
import { ChatServiceError } from "../chat/chatService";
import {
  createAutomationChatDispatchPort,
  type AutomationChatService,
} from "./automationChatDispatchPort";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationRunForDefinition,
} from "./automationTestFixtures";

const threadId = "aa000000-0000-4000-8000-0000000000f8" as ChatThreadId;
const now = "2026-08-10T12:00:00.000Z" as UtcTimestamp;
const chatAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

function chatRun(overrides: Partial<AutomationDefinition> = {}): AutomationRun {
  return automationRunForDefinition(
    automationDefinitionFixture({
      mode: "chat",
      binding: {
        kind: "chat",
        hostId: "local",
        projectId: AUTOMATION_TEST_IDS.project,
        projectVersion: 1,
      },
      executionProfile: {
        profileId: AUTOMATION_TEST_IDS.executionProfile,
        profileVersion: 1,
        hostId: "local",
        mode: "chat",
        projectId: AUTOMATION_TEST_IDS.project,
        providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
        modelId: "approved-model",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
      authorityProfile: {
        profileId: AUTOMATION_TEST_IDS.authorityProfile,
        profileVersion: 1,
        requested: chatAuthority,
        effective: chatAuthority,
        effectiveAuthorityDigest: "automation-authority-digest",
      },
      deliveryTarget: {
        revisionId: AUTOMATION_TEST_IDS.deliveryTargetRevision,
        revision: 1,
        mode: "chat",
        summary: "A short briefing is in the thread.",
        confirmed: true,
        confirmedBy: AUTOMATION_TEST_IDS.actor,
        confirmedAt: "2026-08-10T12:00:00.000Z",
      },
      ...overrides,
    } as never),
  );
}

/** A Chat service holding at most one thread, answering as the real one does. */
function chatService(options: { readonly existing?: boolean; readonly model?: string } = {}) {
  let thread:
    | { id: ChatThreadId; version: number; providerInstanceId: string; modelId: string }
    | undefined = options.existing
    ? {
        id: threadId,
        version: 1,
        providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
        modelId: options.model ?? "approved-model",
      }
    : undefined;
  const sent: Array<unknown> = [];
  const execute = vi.fn(
    async (command: unknown, _context?: Parameters<AutomationChatService["execute"]>[1]) => {
      const { kind } = command as { kind: string };
      if (kind === "send-chat-turn") sent.push(command);
      if (kind === "create-chat-thread") {
        thread = {
          id: threadId,
          version: 1,
          providerInstanceId: "default-instance",
          modelId: "default-model",
        };
        return { kind: "thread-created" };
      }
      if (kind === "change-chat-provider" && thread !== undefined) {
        const change = command as { providerInstanceId: string; modelId: string };
        thread = {
          ...thread,
          version: thread.version + 1,
          providerInstanceId: change.providerInstanceId,
          modelId: change.modelId,
        };
        return { kind: "thread-updated" };
      }
      return { kind: "turn-created" };
    },
  );
  const service = {
    read: (id: ChatThreadId) => {
      if (thread === undefined || id !== thread.id) throw new Error("Chat thread is missing.");
      return { thread, turns: sent } as never;
    },
    execute,
  } satisfies AutomationChatService;
  return { service, execute };
}

describe("createAutomationChatDispatchPort", () => {
  it("creates the thread in the routine's Chat Project with no folder or level", async () => {
    const { service, execute } = chatService();
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });

    const outcome = await port.createThread({ run: chatRun(), threadId, title: "Morning" });

    expect(outcome).toMatchObject({ kind: "created", threadId });
    expect(execute).toHaveBeenCalledWith({
      kind: "create-chat-thread",
      threadId,
      title: "Morning",
      projectId: AUTOMATION_TEST_IDS.project,
    });
  });

  it("finds a thread an earlier attempt already created", async () => {
    const { service, execute } = chatService({ existing: true });
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });

    expect(await port.createThread({ run: chatRun(), threadId, title: "Morning" })).toEqual({
      kind: "existing",
      threadId,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("puts the thread on the routine's model, then sends the task under a stable submission", async () => {
    const { service, execute } = chatService();
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });
    const run = chatRun();
    await port.createThread({ run, threadId, title: "Morning" });

    const input = {
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
    };
    expect(await port.startOrRecoverFirstTurn(input)).toMatchObject({ kind: "accepted" });
    await port.startOrRecoverFirstTurn(input);

    const sent = execute.mock.calls.map(([command]) => command as Record<string, unknown>);
    expect(sent.map((command) => command.kind)).toEqual([
      "create-chat-thread",
      "change-chat-provider",
      "send-chat-turn",
      "send-chat-turn",
    ]);
    expect(sent[1]).toMatchObject({
      providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
      modelId: "approved-model",
    });
    expect(sent[2]).toMatchObject({
      prompt: run.definitionSnapshot.taskPrompt,
      expectedVersion: 2,
    });
    expect(sent[2]?.submissionId).toBe(sent[3]?.submissionId);
    expect(execute.mock.calls[2]?.[1]).toEqual({ hostRun: true });
  });

  it("sends a follow-up into its own thread under the scheduled heading as the host's own turn, leaving the thread's model alone", async () => {
    const { service, execute } = chatService({ existing: true, model: "the-thread-model" });
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });
    const run = chatRun({
      targetPolicy: "same-thread",
      originThreadId: threadId,
      trigger: { kind: "once", scheduledAt: "2026-08-11T09:00:00.000Z" },
      missedRunPolicy: "run-once",
    } as never);

    expect(
      await port.startOrRecoverFirstTurn({
        run,
        threadId,
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: "unused" as never,
      }),
    ).toMatchObject({ kind: "accepted" });

    const sent = execute.mock.calls.map(([command]) => command as Record<string, unknown>);
    expect(sent.map((command) => command.kind)).toEqual(["send-chat-turn"]);
    expect(sent[0]?.prompt).toBe(automationFollowUpTurnPrompt(run.definitionSnapshot.taskPrompt));
    // Sent as the host with no window, so the turn takes Chat's host-run
    // tools (the Canvas on the thread's own Project) rather than none.
    expect(execute.mock.calls[0]?.[1]).toEqual({ hostRun: true });
  });

  it("leaves a model the person chose after the first send alone on a retry", async () => {
    const { service, execute } = chatService();
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });
    const run = chatRun();
    await port.createThread({ run, threadId, title: "Morning" });
    const input = {
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
    };
    await port.startOrRecoverFirstTurn(input);
    await execute({
      kind: "change-chat-provider",
      threadId,
      providerInstanceId: "someone-elses",
      modelId: "their-model",
    });
    execute.mockClear();

    await port.startOrRecoverFirstTurn(input);

    expect(execute.mock.calls.map(([command]) => (command as { kind: string }).kind)).toEqual([
      "send-chat-turn",
    ]);
  });

  it("fails the launch with the Chat service's reason, and waits when it is busy", async () => {
    const { service } = chatService({ existing: true });
    const failing = createAutomationChatDispatchPort({
      chat: {
        ...service,
        execute: async () => {
          throw new ChatServiceError({ category: "unavailable", message: "No provider is ready." });
        },
      },
      clock: () => now,
    });
    const waiting = createAutomationChatDispatchPort({
      chat: {
        ...service,
        execute: async () => {
          throw new ChatServiceError({ category: "waiting", message: "Provider is at capacity." });
        },
      },
      clock: () => now,
    });
    const run = chatRun();
    const input = {
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
    };

    expect(await failing.startOrRecoverFirstTurn(input)).toEqual({
      kind: "failed",
      reason: "provider-launch-failed",
      message: "No provider is ready.",
    });
    expect(await waiting.startOrRecoverFirstTurn(input)).toEqual({
      kind: "waiting-capacity",
      message: "Provider is at capacity.",
    });
  });

  it("refuses a run whose binding is not a Chat Project", async () => {
    const { service } = chatService();
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });
    const workRun = automationRunForDefinition(automationDefinitionFixture());

    expect(await port.createThread({ run: workRun, threadId, title: "Morning" })).toMatchObject({
      kind: "failed",
      reason: "thread-creation-failed",
    });
  });

  it("keeps hostRun set alongside the confirming window when a person confirms a Chat routine", async () => {
    const { service, execute } = chatService({ existing: true });
    const port = createAutomationChatDispatchPort({ chat: service, clock: () => now });
    const run = chatRun();
    const windowId = "00000000-0000-4000-8000-000000000099" as never;

    await port.startOrRecoverFirstTurn({
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
      windowId,
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "send-chat-turn" }), {
      hostRun: true,
      windowId,
    });
  });
});
