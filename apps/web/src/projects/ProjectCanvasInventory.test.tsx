import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectCanvasInventory } from "./ProjectCanvasInventory";
import {
  canvasInventoryEntries,
  canvasInventoryProjectId,
  quarterlyInventoryEntry,
  roadmapInventoryEntry,
} from "./canvasInventoryFixtures";

function createInventoryClient(
  entries = [...canvasInventoryEntries],
): CanvasClient & { inventory: ReturnType<typeof vi.fn> } {
  const inventory = vi.fn(async (_projectId: unknown, query?: string) => {
    const normalized = query?.trim().toLowerCase() ?? "";
    const filtered =
      normalized.length === 0
        ? entries
        : entries.filter((entry) => entry.title.toLowerCase().includes(normalized));
    return { projectId: canvasInventoryProjectId, entries: filtered };
  });
  return {
    inventory,
    get: vi.fn(),
    history: vi.fn(),
    revise: vi.fn(),
    create: vi.fn(),
    threadReferenceCards: vi.fn(),
  };
}

describe("ProjectCanvasInventory", () => {
  it("loads and renders authorized inventory rows", async () => {
    const client = createInventoryClient();
    render(
      <ProjectCanvasInventory
        client={client}
        onOpenCanvas={vi.fn()}
        projectId={canvasInventoryProjectId}
      />,
    );

    expect(screen.getByRole("region", { name: "Canvas inventory" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Quarterly summary")).toBeInTheDocument();
      expect(screen.getByText("Product roadmap")).toBeInTheDocument();
    });
    expect(client.inventory).toHaveBeenCalledWith(canvasInventoryProjectId, "");
  });

  it("passes search queries to the inventory client", async () => {
    const user = userEvent.setup();
    const client = createInventoryClient();
    render(
      <ProjectCanvasInventory
        client={client}
        onOpenCanvas={vi.fn()}
        projectId={canvasInventoryProjectId}
      />,
    );
    await waitFor(() => expect(screen.getByText("Quarterly summary")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox", { name: "Search canvases" }), "roadmap");

    await waitFor(() => {
      expect(screen.queryByText("Quarterly summary")).not.toBeInTheDocument();
      expect(screen.getByText("Product roadmap")).toBeInTheDocument();
    });
    expect(client.inventory).toHaveBeenLastCalledWith(canvasInventoryProjectId, "roadmap");
  });

  it("invokes onOpenCanvas when Open is selected", async () => {
    const user = userEvent.setup();
    const onOpenCanvas = vi.fn();
    render(
      <ProjectCanvasInventory
        client={createInventoryClient()}
        onOpenCanvas={onOpenCanvas}
        projectId={canvasInventoryProjectId}
      />,
    );
    await waitFor(() => expect(screen.getByText("Quarterly summary")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Open" })[0]!);

    expect(onOpenCanvas).toHaveBeenCalledWith(quarterlyInventoryEntry);
  });

  it("shows unavailable and empty states when inventory cannot load", async () => {
    const { rerender } = render(
      <ProjectCanvasInventory
        client={createInventoryClient([])}
        onOpenCanvas={vi.fn()}
        projectId={canvasInventoryProjectId}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Canvas inventory" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("No canvases in this Project yet.")).not.toBeInTheDocument();

    rerender(
      <ProjectCanvasInventory onOpenCanvas={vi.fn()} projectId={canvasInventoryProjectId} />,
    );
    expect(screen.getByText("Canvas inventory is unavailable.")).toBeInTheDocument();
  });
});
