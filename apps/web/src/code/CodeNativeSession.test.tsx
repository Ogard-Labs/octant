import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  decodeCodeNativeSessionId,
  decodeCodeThreadId,
  type CodeNativeSessions,
} from "@octant/contracts";
import { CodeNativeSession } from "./CodeNativeSession";
import type { CodeSessionClient } from "./codeSessionClient";

const threadId = decodeCodeThreadId("22222222-2222-4222-8222-222222222224");
const sessionId = decodeCodeNativeSessionId("6f1c1a2e-0b5d-4c1e-9a43-5d9e0c7f1b20");

function client(initial: CodeNativeSessions) {
  let listed = initial;
  const adoptNativeSession = vi.fn<NonNullable<CodeSessionClient["adoptNativeSession"]>>(
    async () => {
      listed = { threadId, sessions: [], adopted: { nativeSessionId: sessionId } };
      return { kind: "code-native-session-adopted", threadId, nativeSessionId: sessionId };
    },
  );
  const value: CodeSessionClient = {
    liveTasks: async () => ({ threadId, tasks: [], turnRunning: false }),
    stopLiveTasks: async () => ({ kind: "code-live-tasks-stopped", stopped: false }),
    nativeSessions: async () => listed,
    adoptNativeSession,
  };
  return { value, adoptNativeSession };
}

describe("Code native session", () => {
  it("starts an empty thread from a session begun outside Octant and then shows its id", async () => {
    const user = userEvent.setup();
    const { value, adoptNativeSession } = client({
      threadId,
      sessions: [
        {
          nativeSessionId: sessionId,
          title: "Fix the flaky login test",
          gitBranch: "fix/login",
          lastModified: Date.UTC(2026, 10, 14, 12),
        },
      ],
    });
    render(<CodeNativeSession threadId={threadId} threadHasTurns={false} client={value} />);

    await user.click(await screen.findByRole("button", { name: "Continue one" }));
    await user.click(screen.getByRole("radio", { name: /Fix the flaky login test/ }));
    await user.click(screen.getByRole("button", { name: "Continue in this thread" }));

    expect(adoptNativeSession).toHaveBeenCalledWith(threadId, sessionId);
    expect(await screen.findByText(String(sessionId))).toBeTruthy();
    expect(screen.getByLabelText("Thread details")).toBeTruthy();
  });

  it("offers nothing once the thread has messages of its own", async () => {
    const { value } = client({
      threadId,
      sessions: [{ nativeSessionId: sessionId, lastModified: 0 }],
    });
    const listed = vi.spyOn(value, "nativeSessions");
    const { container } = render(
      <CodeNativeSession threadId={threadId} threadHasTurns client={value} />,
    );
    await waitFor(() => expect(listed).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
