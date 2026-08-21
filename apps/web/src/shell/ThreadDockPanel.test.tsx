import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDockPanel } from "./ThreadDockPanel";

const threadId = "10000000-0000-4000-8000-000000000001" as never;
const checkoutId = "20000000-0000-4000-8000-000000000002" as never;

describe("the dock's thread panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists files against the checkout the panel was bound to", async () => {
    const listingRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/code/files/listing")) listingRequests.push(url);
        return new Response(JSON.stringify({ message: "unavailable" }), {
          headers: { "content-type": "application/json" },
          status: 503,
        });
      }),
    );

    render(
      <ThreadDockPanel
        checkoutId={checkoutId}
        onOpenFile={vi.fn()}
        serverUrl="http://127.0.0.1:4317"
        threadId={threadId}
        windowCapability="window-capability"
      />,
    );

    await waitFor(() => expect(listingRequests).toHaveLength(1), { timeout: 5_000 });
    const query = new URL(String(listingRequests[0]), "http://127.0.0.1").searchParams;
    expect(query.get("threadId")).toBe(String(threadId));
    expect(query.get("checkoutId")).toBe(String(checkoutId));
  });

  it("does not offer child creation until Code can provide a verified isolated worktree", async () => {
    const user = userEvent.setup();
    const requestRun = vi.fn(async (_input: unknown) => ({ kind: "run-accepted" as const }));
    const agentRunClient = {
      parentSummary: vi.fn(async () => ({ parentThreadId: threadId, entries: [] })),
      acknowledge: vi.fn(),
      cancel: vi.fn(async () => ({ results: [] })),
      requestRun,
    } as never;
    render(
      <ThreadDockPanel agentRunClient={agentRunClient} onOpenFile={vi.fn()} threadId={threadId} />,
    );

    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Active / History" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("reads nothing for a group until that group is opened", () => {
    const parentSummary = vi.fn(async () => ({ parentThreadId: threadId, entries: [] }));
    render(
      <ThreadDockPanel
        agentRunClient={{ parentSummary, acknowledge: vi.fn(), cancel: vi.fn() } as never}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(parentSummary).not.toHaveBeenCalled();
  });
});
