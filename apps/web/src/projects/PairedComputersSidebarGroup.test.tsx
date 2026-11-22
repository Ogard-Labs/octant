import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ALL_ENVIRONMENTS } from "@octant/client-runtime/environment-selection";
import {
  buildFederatedReadItem,
  type FederatedHostReadFreshness,
} from "@octant/client-runtime/host-federation-merged-reads";
import type { PairedComputerThreadPayload } from "@octant/client-runtime/paired-computer-reads";
import { PairedComputersSidebarGroup } from "./PairedComputersSidebarGroup";

const studio = "30000000-0000-4000-8000-000000000001";
const laptop = "30000000-0000-4000-8000-000000000002";

function thread(input: {
  readonly hostId: string;
  readonly computer: string;
  readonly threadId: string;
  readonly title: string;
  readonly state: PairedComputerThreadPayload["state"];
  readonly freshness?: FederatedHostReadFreshness;
}) {
  return buildFederatedReadItem<PairedComputerThreadPayload>({
    hostId: input.hostId,
    entityId: input.threadId,
    kind: "thread",
    hostDisplayName: input.computer,
    title: input.title,
    sortKey: "2026-11-20T10:00:00.000Z",
    ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
    payload: {
      mode: "code",
      threadId: input.threadId,
      projectId: "20000000-0000-4000-8000-000000000001",
      state: input.state,
      updatedAt: "2026-11-20T10:00:00.000Z",
    },
  });
}

const threads = [
  thread({
    hostId: studio,
    computer: "Studio",
    threadId: "10000000-0000-4000-8000-000000000001",
    title: "Fix the login flow",
    state: "needs-you",
  }),
  thread({
    hostId: laptop,
    computer: "Laptop",
    threadId: "10000000-0000-4000-8000-000000000002",
    title: "Tidy the release notes",
    state: "idle",
    freshness: "stale",
  }),
];

describe("PairedComputersSidebarGroup", () => {
  it("lists each computer's threads under its name and opens one on that computer", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(
      <PairedComputersSidebarGroup
        onOpenThread={onOpenThread}
        selection={ALL_ENVIRONMENTS}
        threads={threads}
      />,
    );

    const group = screen.getByRole("region", { name: "On your other computers" });
    const onStudio = within(group).getByRole("list", { name: "Threads on Studio" });
    const row = within(onStudio).getByRole("button", { name: "Fix the login flow on Studio" });
    expect(row).toHaveTextContent("Needs you");
    await user.click(row);
    expect(onOpenThread).toHaveBeenCalledWith(studio, "10000000-0000-4000-8000-000000000001");
  });

  it("keeps a computer that stopped answering in the list, marked and not openable", () => {
    render(
      <PairedComputersSidebarGroup
        onOpenThread={vi.fn()}
        selection={ALL_ENVIRONMENTS}
        threads={threads}
      />,
    );

    expect(screen.getByText(/not connected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tidy the release notes on Laptop" })).toBeDisabled();
  });

  it("shows only the computers the Environments filter selects", () => {
    render(
      <PairedComputersSidebarGroup
        onOpenThread={vi.fn()}
        selection={{ kind: "some", hostIds: new Set([studio]) }}
        threads={threads}
      />,
    );

    expect(screen.getByRole("list", { name: "Threads on Studio" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Threads on Laptop" })).toBeNull();
  });
});
