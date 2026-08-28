import { decodeChatThreadView, type ChatThreadView } from "@octant/contracts/chat";
import { decodeHostId } from "@octant/contracts/host";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeWorkThreadId, type WorkThread, type WorkTurnState } from "@octant/contracts";
import { THREAD_EXPORT_FORMAT } from "@octant/contracts/thread-export";
import { describe, expect, it } from "vitest";
import { ThreadExportService } from "./threadExportService";

const now = "2026-08-19T12:00:00.000Z";
const windowId = "70000000-0000-4000-8000-000000000001";
const threadId = "00000000-0000-4000-8000-000000000901";
const workThreadId = "00000000-0000-4000-8000-000000000902";
const projectId = "20000000-0000-4000-8000-000000000001";
const ids = {
  turn: "00000000-0000-4000-8000-000000000911",
  attempt: "00000000-0000-4000-8000-000000000912",
  user: "00000000-0000-4000-8000-000000000913",
  assistant: "00000000-0000-4000-8000-000000000914",
  attachment: "00000000-0000-4000-8000-000000000915",
} as const;

function reference(contentId: string, digest: string) {
  return { contentId, digest: digest.repeat(64), byteLength: 12 };
}

function chatView() {
  return decodeChatThreadView({
    thread: {
      id: threadId,
      title: "Launch plan",
      lifecycle: "active",
      projectId,
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: 4,
      createdAt: now,
      updatedAt: now,
    },
    lastSequence: 9,
    turns: [
      {
        id: ids.turn,
        threadId,
        sequence: 1,
        userMessageRef: reference(ids.user, "a"),
        attachmentIds: [ids.attachment],
        attempts: [
          {
            id: ids.attempt,
            turnId: ids.turn,
            threadId,
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            providerSessionId: "20000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            contextManifestId: "30000000-0000-4000-8000-000000000001",
            outcome: "completed",
            responseRefs: [reference(ids.assistant, "b")],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      },
    ],
    contents: [
      {
        contentId: ids.user,
        role: "user",
        body: "What should we ship first?",
        digest: "a".repeat(64),
        byteLength: 26,
      },
      {
        contentId: ids.assistant,
        role: "assistant",
        body: "Start with the transcript.",
        digest: "b".repeat(64),
        byteLength: 26,
      },
    ],
    attachments: [
      {
        id: ids.attachment,
        threadId,
        displayName: "brief.pdf",
        mediaType: "application/pdf",
        byteLength: 1200,
        digest: "c".repeat(64),
        status: "finalized",
        createdAt: now,
      },
    ],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  });
}

function service(
  options: {
    readonly chat?: ChatThreadView | undefined;
    readonly work?: { readonly thread: WorkThread; readonly turns: ReadonlyArray<WorkTurnState> };
    readonly generatedImages?: {
      readonly listByScope: (scopeId: string) => ReadonlyArray<unknown>;
    };
  } = {},
) {
  return new ThreadExportService({
    hostId: decodeHostId("local"),
    clock: () => now,
    chat: { read: () => options.chat },
    work: { read: async () => options.work },
    code: {
      readThread: async () => undefined,
      conversation: async () => {
        throw new Error("Code conversation is unused in this test.");
      },
      readEvidence: async () => {
        throw new Error("Code evidence is unused in this test.");
      },
    },
    canvases: { byThread: () => [] },
    ...(options.generatedImages === undefined
      ? {}
      : { generatedImages: options.generatedImages as never }),
  });
}

describe("ThreadExportService", () => {
  it("exports a thread the caller can already read, with transcript, evidence, and a cut time", async () => {
    const outcome = await service({ chat: chatView() }).exportThread(
      windowId as never,
      "local-window",
      { mode: "chat", threadId },
    );
    expect(outcome.kind).toBe("exported");
    if (outcome.kind !== "exported") return;
    expect(outcome.bundle.octant).toMatchObject({
      format: THREAD_EXPORT_FORMAT,
      threadId,
      mode: "chat",
      generatedAt: now,
      sequence: 9,
    });
    expect(outcome.bundle.transcript.entries.map((entry) => entry.text)).toEqual([
      "What should we ship first?",
      "Start with the transcript.",
    ]);
    expect(outcome.bundle.evidence.attachments[0]?.displayName).toBe("brief.pdf");
    expect(outcome.bundle.omissions.some((omission) => omission.kind === "attachment-bytes")).toBe(
      true,
    );
    expect(JSON.stringify(outcome.bundle)).not.toContain("credentials");
    expect(JSON.stringify(outcome.bundle)).not.toContain("resumeCursor");
  });

  it("includes generated images with provenance and omits their bytes", async () => {
    const jobId = "a1000000-0000-4000-8000-000000000021";
    const attachmentId = "a1000000-0000-4000-8000-000000000022";
    const outcome = await service({
      chat: chatView(),
      generatedImages: {
        listByScope: () => [
          {
            id: jobId,
            status: "completed",
            threadKind: "chat-thread",
            scopeId: threadId,
            profileInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "gpt-image-2",
            promptHash: "d".repeat(64),
            artifacts: [
              {
                attachmentId,
                hash: "e".repeat(64),
                size: 48,
                mime: "image/png",
                evidence: {
                  profileInstanceId: "10000000-0000-4000-8000-000000000001",
                  modelId: "gpt-image-2",
                  promptHash: "d".repeat(64),
                  jobId,
                },
              },
            ],
            version: 3,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    }).exportThread(windowId as never, "local-window", { mode: "chat", threadId });
    expect(outcome.kind).toBe("exported");
    if (outcome.kind !== "exported") return;
    const generated = outcome.bundle.evidence.attachments.find(
      (attachment) => attachment.generation?.jobId === jobId,
    );
    expect(generated?.displayName).toBe(`generated-${jobId}-1.png`);
    expect(generated?.generation?.jobId).toBe(jobId);
    expect(generated?.generation?.modelId).toBe("gpt-image-2");
    expect(JSON.stringify(outcome.bundle)).not.toContain("iVBOR");
  });

  it("lets a paired device export a thread it can already read", async () => {
    const outcome = await service({ chat: chatView() }).exportThread(
      windowId as never,
      "remote-device",
      { mode: "chat", threadId },
    );
    expect(outcome.kind).toBe("exported");
  });

  it("refuses a provider or a thread the caller cannot read", async () => {
    expect(
      await service({ chat: chatView() }).exportThread(windowId as never, "provider", {
        mode: "chat",
        threadId,
      }),
    ).toEqual({ kind: "refused", reason: "unauthorized" });
    expect(
      await service({ chat: undefined }).exportThread(windowId as never, "local-window", {
        mode: "chat",
        threadId,
      }),
    ).toEqual({ kind: "refused", reason: "not-found" });
  });

  it("exports a Work thread's journaled transcript and completion evidence", async () => {
    const workThread = {
      id: decodeWorkThreadId(workThreadId),
      projectId: decodeProjectId(projectId),
      title: "Brief",
      lifecycle: "active",
      completionEvidence: {
        deliveryTarget: "Brief",
        satisfactionEvidence: "The brief is on disk.",
      },
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      version: 3,
      createdAt: now,
      updatedAt: now,
    } as unknown as WorkThread;
    const turn = {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      threadId: workThreadId,
      turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId,
      status: "completed",
      prompt: "Write the brief.",
      transcript: [
        { role: "user", text: "Write the brief." },
        { role: "assistant", text: "Here is the brief." },
      ],
      acceptedAt: now,
      updatedAt: now,
    } as unknown as WorkTurnState;
    const outcome = await service({
      work: { thread: workThread, turns: [turn] },
    }).exportThread(windowId as never, "local-window", { mode: "work", threadId: workThreadId });
    expect(outcome.kind).toBe("exported");
    if (outcome.kind !== "exported") return;
    expect(outcome.bundle.transcript.entries.map((entry) => entry.text)).toEqual([
      "Write the brief.",
      "Here is the brief.",
    ]);
    expect(outcome.bundle.evidence.completion?.satisfactionEvidence).toBe("The brief is on disk.");
  });
});
