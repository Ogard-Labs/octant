import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createNativeHarnessSessionRouteHandler } from "./nativeHarnessSessionRoutes";

const threadId = "00000000-0000-4000-8000-000000000020";
const sessionId = "00000000-0000-4000-8000-000000000021";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000611");

function resumeFrom(status: "recovery-required" | "paused-by-user") {
  const lifted = vi.fn();
  const handler = createNativeHarnessSessionRouteHandler({
    windowAuthorityStore: new WindowAuthorityStore(),
    store: {
      read: () => ({ session: { id: sessionId, version: 3, status, mode: "code" } }),
      pause: () => false,
      resume: () => true,
      turnInFlight: () => false,
    } as never,
    followUps: {} as never,
    authorizeThread: () => true,
    onRecoveryLifted: lifted,
  });
  const request = new Request(`http://127.0.0.1/api/native-harness/sessions/${threadId}/commands`, {
    method: "POST",
    body: JSON.stringify({
      kind: "resume-native-harness-session",
      sessionId,
      expectedVersion: 3,
    }),
  });
  bindPrincipalRouteContext(request, {
    principal: { kind: "local-window" } as never,
    scopeId: windowId,
  });
  return { lifted, response: handler(request) };
}

describe("native harness session routes", () => {
  it("tells the thread's other records the cut-off turn is settled once a resume clears a restart recovery", async () => {
    const { lifted, response } = resumeFrom("recovery-required");
    expect((await response)?.status).toBe(200);
    expect(lifted).toHaveBeenCalledExactlyOnceWith({ threadId, mode: "code" });
  });

  it("settles nothing elsewhere when a resume only lifts a pause", async () => {
    const { lifted, response } = resumeFrom("paused-by-user");
    expect((await response)?.status).toBe(200);
    expect(lifted).not.toHaveBeenCalled();
  });

  it("refuses an answer to the lead's question from a window that may not open the thread", async () => {
    // The thread's inline question card and the Agents tab both post here; the
    // window's reach is checked on the host, never only by the card.
    const questionId = "00000000-0000-4000-8000-000000000022";
    let mayOpen = false;
    const answerQuestion = vi.fn(() => "answered" as const);
    const handler = createNativeHarnessSessionRouteHandler({
      windowAuthorityStore: new WindowAuthorityStore(),
      store: {
        read: () => ({
          session: { id: sessionId, version: 3, status: "running", mode: "work" },
          questions: [
            {
              id: questionId,
              prompt: "Which quarter?",
              options: [],
              status: "answered",
              answer: "Q3",
              askedAt: "2026-10-06T08:00:00.000Z",
            },
          ],
        }),
      } as never,
      followUps: {} as never,
      authorizeThread: () => mayOpen,
      answerQuestion,
    });
    const answer = () => {
      const request = new Request(
        `http://127.0.0.1/api/native-harness/sessions/${threadId}/questions`,
        { method: "POST", body: JSON.stringify({ questionId, answer: "Q3" }) },
      );
      bindPrincipalRouteContext(request, {
        principal: { kind: "local-window" } as never,
        scopeId: windowId,
      });
      return handler(request);
    };
    expect((await answer())?.status).toBe(403);
    expect(answerQuestion).not.toHaveBeenCalled();
    mayOpen = true;
    expect((await answer())?.status).toBe(200);
    expect(answerQuestion).toHaveBeenCalledExactlyOnceWith({ threadId, questionId, answer: "Q3" });
  });
});
