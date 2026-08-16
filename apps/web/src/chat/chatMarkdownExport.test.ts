import { decodeChatThreadView } from "@octant/contracts/chat";
import { describe, expect, it } from "vitest";
import { buildChatMarkdownExport } from "./chatMarkdownExport";

const now = "2026-07-20T08:00:00.000Z";
const ids = {
  thread: "00000000-0000-4000-8000-000000000901",
  turn: "00000000-0000-4000-8000-000000000902",
  attempt: "00000000-0000-4000-8000-000000000903",
  userContent: "00000000-0000-4000-8000-000000000904",
  responseContent: "00000000-0000-4000-8000-000000000905",
  revisedTurn: "00000000-0000-4000-8000-000000000906",
  revisedContent: "00000000-0000-4000-8000-000000000907",
  attachment: "00000000-0000-4000-8000-000000000908",
  sourceThread: "00000000-0000-4000-8000-000000000909",
} as const;

function reference(contentId: string, digest: string) {
  return { contentId, digest: digest.repeat(64), byteLength: 12 };
}

function body(contentId: string, role: "user" | "assistant", text: string, digest: string) {
  return { contentId, role, body: text, digest: digest.repeat(64), byteLength: text.length };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.attempt,
    turnId: ids.turn,
    threadId: ids.thread,
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    providerSessionId: "20000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    contextManifestId: "30000000-0000-4000-8000-000000000001",
    outcome: "completed",
    responseRefs: [reference(ids.responseContent, "b")],
    citationIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function viewFixture(overrides: Record<string, unknown> = {}) {
  return decodeChatThreadView({
    thread: {
      id: ids.thread,
      title: "Launch plan",
      lifecycle: "active",
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
        threadId: ids.thread,
        sequence: 1,
        userMessageRef: reference(ids.userContent, "a"),
        attachmentIds: [],
        attempts: [attempt()],
        createdAt: now,
      },
    ],
    contents: [
      body(ids.userContent, "user", "What should we ship first?", "a"),
      body(ids.responseContent, "assistant", "Start with the transcript.", "b"),
    ],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
    ...overrides,
  });
}

describe("buildChatMarkdownExport", () => {
  it("exports the whole conversation with its provenance and claims no gaps", () => {
    const exported = buildChatMarkdownExport({
      view: viewFixture(),
      connectionStatus: "connected",
    });

    expect(exported.markdown).toContain("# Launch plan");
    expect(exported.markdown).toContain("- Messages: 1");
    expect(exported.markdown).toContain("Exported at thread revision 4 (event 9)");
    expect(exported.markdown).toContain("## You\n\nWhat should we ship first?");
    expect(exported.markdown).toContain("## Assistant\n\nStart with the transcript.");
    expect(exported.markdown).not.toContain("## About this export");
    expect(exported.complete).toBe(true);
    expect(exported.fileName).toBe("launch-plan.md");
  });

  it("exports the active conversation and counts the revisions it left out", () => {
    const base = viewFixture();
    const exported = buildChatMarkdownExport({
      view: viewFixture({
        turns: [
          ...base.turns,
          {
            id: ids.revisedTurn,
            threadId: ids.thread,
            sequence: 2,
            userMessageRef: reference(ids.revisedContent, "c"),
            attachmentIds: [],
            attempts: [],
            supersedes: ids.turn,
            createdAt: now,
          },
        ],
        contents: [...base.contents, body(ids.revisedContent, "user", "What ships first?", "c")],
      }),
    });

    expect(exported.markdown).toContain("What ships first?");
    expect(exported.markdown).not.toContain("What should we ship first?");
    expect(exported.markdown).toContain("## About this export");
    expect(exported.markdown).toContain("1 superseded message was revised");
  });

  it("never claims a whole export when it left attachment contents out", () => {
    // The Markdown names an attachment but cannot carry its bytes, so the
    // export is partial: the control must show its partial-export warning
    // rather than reporting an unqualified success.
    const view = viewFixture();
    const exported = buildChatMarkdownExport({
      view: {
        ...view,
        turns: [{ ...view.turns[0]!, attachmentIds: [ids.attachment] }],
      } as never,
      connectionStatus: "connected",
    });

    expect(exported.markdown).toContain("their file contents are not part of this Markdown export");
    expect(exported.complete).toBe(false);
  });

  it("never presents an incomplete export as whole", () => {
    const base = viewFixture();
    const exported = buildChatMarkdownExport({
      view: viewFixture({
        turns: [
          {
            ...base.turns[0]!,
            attachmentIds: [ids.attachment],
            attempts: [attempt({ outcome: "streaming" })],
          },
        ],
        attachments: [
          {
            id: ids.attachment,
            threadId: ids.thread,
            turnId: ids.turn,
            displayName: "plan.pdf",
            mediaType: "application/pdf",
            byteLength: 64,
            digest: "d".repeat(64),
            status: "finalized",
            createdAt: now,
          },
        ],
      }),
      connectionStatus: "disconnected",
    });

    expect(exported.complete).toBe(false);
    expect(exported.markdown).toContain("This response was still streaming when the export");
    expect(exported.markdown).toContain("1 attachment is referenced by name only");
    expect(exported.markdown).toContain("not connected to the authoritative transcript");
    expect(exported.markdown).toContain("plan.pdf");
  });

  it("says which messages it could not read instead of dropping them silently", () => {
    const exported = buildChatMarkdownExport({
      view: viewFixture({ contents: [] }),
    });

    expect(exported.complete).toBe(false);
    expect(exported.markdown).toContain("could not be read from local storage");
    expect(exported.markdown).toContain("2 messages could not be read");
  });

  it("records a branch's origin in the export header", () => {
    const base = viewFixture();
    const exported = buildChatMarkdownExport({
      view: viewFixture({
        thread: {
          ...base.thread,
          branchedFrom: {
            threadId: ids.sourceThread,
            turnId: ids.turn,
            sourceVersion: 3,
            carriedTurnCount: 1,
            omittedAttachmentCount: 0,
            branchedAt: now,
          },
        },
      }),
    });

    expect(exported.markdown).toContain(
      "- Branched from another thread at revision 3, carrying 1 message",
    );
  });
});
