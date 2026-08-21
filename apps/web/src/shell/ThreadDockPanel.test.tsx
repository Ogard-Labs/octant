import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("starts a subagent under this thread's own identity", async () => {
    // The managed child runtime is reachable only through an explicit creation
    // request. Rendering the hierarchy read-only would leave that runtime with
    // no production surface at all, so the panel bound to the parent thread —
    // the authority the host already verifies — must offer creation.
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
    const form = await screen.findByRole("form", { name: "Create subagent" });
    expect(form).toBeVisible();

    await user.type(within(form).getByLabelText("Task"), "Summarize the failing tests.");
    await user.type(
      within(form).getByLabelText("Provider instance ID"),
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    await user.type(within(form).getByLabelText("Model ID"), "model-one");
    await user.click(within(form).getByRole("button", { name: "Create subagent" }));

    await waitFor(() => expect(requestRun).toHaveBeenCalledTimes(1));
    expect(requestRun.mock.calls[0]?.[0]).toMatchObject({
      // The parent identity is the thread the panel is bound to; the host
      // authorizes creation against exactly that thread.
      parentThreadId: threadId,
      task: "Summarize the failing tests.",
    });
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
