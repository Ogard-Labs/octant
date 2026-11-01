import type { BrowserFlowsResult } from "@octant/contracts/browser-flows";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserFlowsSection } from "./BrowserFlowsSection";

const projectId = "40000000-0000-4000-8000-000000000001" as never;
const listing: BrowserFlowsResult = {
  kind: "browser-flows",
  flows: [
    {
      projectId,
      projectLabel: "Docs site",
      name: "Check the order form",
      stepCount: 3,
      firstAddress: "http://127.0.0.1:4173/form",
      savedAt: "2026-11-01T09:00:00.000Z" as never,
    },
    {
      projectId,
      projectLabel: "Docs site",
      name: "Scroll",
      stepCount: 1,
      savedAt: "2026-11-01T09:05:00.000Z" as never,
    },
  ],
};

describe("BrowserFlowsSection", () => {
  it("lists each saved flow with its Project, step count, and first address", async () => {
    const manageFlows = vi.fn(async () => listing);
    render(<BrowserFlowsSection client={{ manageFlows }} />);

    expect(await screen.findByText("Check the order form")).toBeInTheDocument();
    expect(
      screen.getByText("Docs site · 3 steps · starts at http://127.0.0.1:4173/form"),
    ).toBeInTheDocument();
    expect(screen.getByText("Docs site · 1 step")).toBeInTheDocument();
    expect(manageFlows).toHaveBeenCalledWith({ kind: "list" });
  });

  it("deletes a flow only after the person confirms, then lists again", async () => {
    const user = userEvent.setup();
    const manageFlows = vi.fn(async (command: { kind: string }) =>
      command.kind === "delete"
        ? ({
            kind: "browser-flow-deleted",
            projectId,
            name: "Scroll",
          } as BrowserFlowsResult)
        : listing,
    );
    render(<BrowserFlowsSection client={{ manageFlows }} />);
    await screen.findByText("Scroll");

    await user.click(screen.getByRole("button", { name: "Delete flow Scroll" }));
    expect(manageFlows).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(manageFlows).toHaveBeenCalledWith({ kind: "delete", projectId, name: "Scroll" }),
    );
    expect(await screen.findByText("Deleted “Scroll”.")).toBeInTheDocument();
    await waitFor(() => expect(manageFlows).toHaveBeenCalledTimes(3));
  });

  it("says so when no flow is saved and when the host refuses", async () => {
    const empty = render(
      <BrowserFlowsSection
        client={{ manageFlows: async () => ({ kind: "browser-flows", flows: [] }) }}
      />,
    );
    expect(await screen.findByText(/No saved flows/)).toBeInTheDocument();
    empty.unmount();

    render(
      <BrowserFlowsSection
        client={{
          manageFlows: async () => ({
            kind: "browser-flows-refused",
            reason: "not-local",
            message: "Browser flows are managed only on this Mac.",
          }),
        }}
      />,
    );
    expect(
      await screen.findByText("Browser flows are managed only on this Mac."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete flow/ })).not.toBeInTheDocument();
  });

  it("reports a flow that is already gone instead of claiming it deleted it", async () => {
    const user = userEvent.setup();
    const manageFlows = vi.fn(async (command: { kind: string }) =>
      command.kind === "delete"
        ? ({
            kind: "browser-flows-refused",
            reason: "not-found",
            message: "That flow no longer exists.",
          } as BrowserFlowsResult)
        : listing,
    );
    render(<BrowserFlowsSection client={{ manageFlows }} />);
    await user.click(await screen.findByRole("button", { name: "Delete flow Scroll" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("That flow no longer exists.")).toBeInTheDocument();
  });
});
