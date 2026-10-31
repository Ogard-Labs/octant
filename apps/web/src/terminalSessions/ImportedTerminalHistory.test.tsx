import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TerminalSessionClient } from "@octant/client-runtime/terminal-session-client";
import { ImportedTerminalHistory } from "./ImportedTerminalHistory";

function client(imported: Awaited<ReturnType<TerminalSessionClient["history"]>>) {
  return { list: async () => [], history: async () => imported } as TerminalSessionClient;
}

describe("ImportedTerminalHistory", () => {
  it("shows the session a thread started from, folded and marked as outside content", async () => {
    const user = userEvent.setup();
    render(
      <ImportedTerminalHistory
        client={client({
          provider: "claude",
          sessionId: "0b4c1f2e-1111-4111-8111-111111111111" as never,
          title: "Upload test flake",
          updatedAt: "2026-10-30T09:00:00.000Z" as never,
          importedAt: "2026-10-31T09:00:00.000Z" as never,
          entries: [
            { role: "user", text: "Fix the flaky upload test" },
            { role: "assistant", text: "The retry races the timer." },
          ],
          truncated: true,
        })}
        threadId="00000000-0000-4000-8000-000000000020"
      />,
    );

    const summary = await screen.findByText(
      "Started from a Claude Code session: Upload test flake",
    );
    expect(screen.getByText("Fix the flaky upload test")).not.toBeVisible();
    await user.click(summary);
    expect(screen.getByText("Fix the flaky upload test")).toBeVisible();
    expect(screen.getByText(/Outside content, read from this Mac/)).toHaveTextContent(
      "Older messages were left out.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows nothing on a thread that did not start from a session", async () => {
    const { container } = render(
      <ImportedTerminalHistory
        client={client(undefined)}
        threadId="00000000-0000-4000-8000-000000000020"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
