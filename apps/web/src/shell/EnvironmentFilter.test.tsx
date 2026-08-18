import {
  ALL_ENVIRONMENTS,
  type EnvironmentSelection,
} from "@octant/client-runtime/environment-selection";
import type { FederatedHostState } from "@octant/client-runtime";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentFilter } from "./EnvironmentFilter";

const local = "host-local";
const devbox = "host-devbox";

const hostStates = [
  { hostId: devbox, hostDisplayName: "Devbox", freshness: "ready", itemCount: 4 },
  { hostId: local, hostDisplayName: "Henrik's Mac", freshness: "ready", itemCount: 7 },
] as unknown as ReadonlyArray<FederatedHostState>;

async function openFilter(
  overrides: {
    readonly selection?: EnvironmentSelection;
    readonly hostStates?: ReadonlyArray<FederatedHostState>;
  } = {},
) {
  const user = userEvent.setup();
  const onSelectionChange = vi.fn();
  render(
    <EnvironmentFilter
      hostStates={overrides.hostStates ?? hostStates}
      localHostId={local}
      onSelectionChange={onSelectionChange}
      selection={overrides.selection ?? ALL_ENVIRONMENTS}
    />,
  );
  await user.click(screen.getByRole("button"));
  return { user, onSelectionChange };
}

describe("choosing which environments a list gathers from", () => {
  it("names this machine Local and puts it first", async () => {
    await openFilter();

    const rows = screen.getAllByRole("checkbox");
    expect(rows).toHaveLength(3);
    expect(screen.getByText("Local")).toBeVisible();
    expect(screen.getByText("Devbox")).toBeVisible();
  });

  it("summarises the selection by name rather than by count while there are few", async () => {
    await openFilter({ selection: { kind: "some", hostIds: new Set([devbox]) } });

    expect(screen.getByRole("button", { name: /Devbox/ })).toBeVisible();
  });

  it("unticking one environment while All is on means everything except it", async () => {
    const { user, onSelectionChange } = await openFilter();

    await user.click(screen.getByRole("checkbox", { name: /Devbox/ }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      kind: "some",
      hostIds: new Set([local]),
    });
  });

  it("unticking the master selects none rather than silently meaning everything", async () => {
    const { user, onSelectionChange } = await openFilter();

    await user.click(screen.getByRole("checkbox", { name: "All environments" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ kind: "some", hostIds: new Set() });
  });

  it("keeps an unreachable environment on the list and says so", async () => {
    await openFilter({
      hostStates: [
        { hostId: devbox, hostDisplayName: "Devbox", freshness: "unavailable", itemCount: 4 },
        { hostId: local, hostDisplayName: "Henrik's Mac", freshness: "ready", itemCount: 7 },
      ] as unknown as ReadonlyArray<FederatedHostState>,
    });

    // A host that dropped out is a thing to see, not a thing to hide.
    expect(screen.getByText("Devbox")).toBeVisible();
    expect(screen.getByText("unreachable")).toBeVisible();
    expect(screen.getByText("4")).toBeVisible();
  });
});
