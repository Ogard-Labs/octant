import {
  decodeChatAttempt,
  decodeChatContentBody,
  decodeChatEventFrame,
  decodeChatThreadId,
  decodeChatThreadView,
  type ChatAttempt,
  type ChatContentBody,
  type ChatEventFrame,
  type ChatThreadView,
} from "@octant/contracts/chat";
import { describe, expect, it } from "vitest";
import { applyChatAttemptFrame } from "./chatStreamFrames";

const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000802");
const now = "2026-07-19T12:00:00.000Z";
const turnId = "00000000-0000-4000-8000-000000000901";

function body(contentId: string, text: string): ChatContentBody {
  return decodeChatContentBody({
    contentId,
    role: "assistant",
    body: text,
    digest: "b".repeat(64),
    byteLength: text.length,
  });
}

function reference(content: ChatContentBody) {
  return { contentId: content.contentId, digest: content.digest, byteLength: content.byteLength };
}

function attempt(
  outcome: ChatAttempt["outcome"],
  responses: ReadonlyArray<ChatContentBody>,
  turn = turnId,
): ChatAttempt {
  return decodeChatAttempt({
    id: "00000000-0000-4000-8000-000000000903",
    turnId: turn,
    threadId,
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    providerSessionId: "00000000-0000-4000-8000-000000000904",
    modelId: "model-a",
    contextManifestId: "00000000-0000-4000-8000-000000000905",
    outcome,
    responseRefs: responses.map(reference),
    citationIds: [],
    createdAt: now,
    updatedAt: now,
  });
}

const prompt = body("00000000-0000-4000-8000-000000000902", "?");

function view(
  attempts: ReadonlyArray<ChatAttempt>,
  contents: ReadonlyArray<ChatContentBody>,
): ChatThreadView {
  return decodeChatThreadView({
    thread: {
      id: threadId,
      title: "Planning",
      lifecycle: "active",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    turns: [
      {
        id: turnId,
        threadId,
        sequence: 1,
        userMessageRef: reference(prompt),
        attachmentIds: [],
        attempts,
        createdAt: now,
      },
    ],
    lastSequence: 4,
    contents: [prompt, ...contents],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  });
}

function frame(
  sequence: number,
  updated: ChatAttempt,
  contents?: ReadonlyArray<ChatContentBody>,
): ChatEventFrame {
  return decodeChatEventFrame({
    threadId,
    sequence,
    event: { kind: "attempt-updated", attempt: updated },
    ...(contents === undefined ? {} : { contents }),
  });
}

const first = body("00000000-0000-4000-8000-000000000911", "Hello");
const second = body("00000000-0000-4000-8000-000000000912", ", world");

describe("applyChatAttemptFrame", () => {
  it("grows a streaming reply from the body its frame carries", () => {
    const current = view([attempt("streaming", [first])], [first]);
    const grown = applyChatAttemptFrame(
      current,
      frame(5, attempt("streaming", [first, second]), [second]),
    );
    expect(grown?.lastSequence).toBe(5);
    expect(grown?.turns[0]?.attempts[0]?.responseRefs).toHaveLength(2);
    expect(grown?.contents.map((content) => content.body)).toEqual(["?", "Hello", ", world"]);
  });

  it("asks for the thread when a frame lacks a body the attempt now references", () => {
    const current = view([attempt("streaming", [first])], [first]);
    expect(
      applyChatAttemptFrame(current, frame(5, attempt("streaming", [first, second]))),
    ).toBeUndefined();
  });

  it("asks for the thread once the attempt settles, and for a turn it has not seen", () => {
    const current = view([attempt("streaming", [first])], [first]);
    expect(
      applyChatAttemptFrame(current, frame(5, attempt("completed", [first, second]), [second])),
    ).toBeUndefined();
    const elsewhere = attempt("streaming", [first, second], "00000000-0000-4000-8000-000000000999");
    expect(applyChatAttemptFrame(current, frame(5, elsewhere, [second]))).toBeUndefined();
  });
});
