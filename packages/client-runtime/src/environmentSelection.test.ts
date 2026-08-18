import { describe, expect, it } from "vitest";
import {
  ALL_ENVIRONMENTS,
  allEnvironmentsSelected,
  environmentLabel,
  environmentReach,
  environmentRows,
  environmentSelectionSummary,
  selectEnvironmentItems,
  toggleAllEnvironments,
  toggleEnvironment,
  type EnvironmentSelection,
} from "./environmentSelection";
import type { FederatedHostState, FederatedReadItem } from "./hostFederationMergedReads";

const local = "host-local";
const devbox = "host-devbox";
const laptop = "host-laptop";
const known = [local, devbox, laptop];

function hostStates(
  overrides: Partial<Record<string, FederatedHostState["freshness"]>> = {},
): ReadonlyArray<FederatedHostState> {
  return [
    {
      hostId: devbox,
      hostDisplayName: "Devbox",
      freshness: overrides[devbox] ?? "ready",
      itemCount: 4,
    },
    {
      hostId: local,
      hostDisplayName: "Henrik's Mac",
      freshness: overrides[local] ?? "ready",
      itemCount: 7,
    },
    {
      hostId: laptop,
      hostDisplayName: "Aero",
      freshness: overrides[laptop] ?? "ready",
      itemCount: 1,
    },
  ] as unknown as ReadonlyArray<FederatedHostState>;
}

function item(hostId: string, title: string): FederatedReadItem<{ readonly hostId: string }> {
  return {
    ref: { hostId, entityId: title } as never,
    kind: "thread",
    hostDisplayName: hostId,
    title,
    sortKey: title,
    searchableText: title,
    freshness: "ready",
    readOnly: false,
    tags: [],
    payload: { hostId },
  } as unknown as FederatedReadItem<{ readonly hostId: string }>;
}

describe("naming an environment", () => {
  it("calls the host you are sitting at Local, whatever it is named", () => {
    expect(
      environmentLabel({ hostId: local, hostDisplayName: "Henrik's Mac", localHostId: local }),
    ).toBe("Local");
    expect(
      environmentLabel({ hostId: devbox, hostDisplayName: "Devbox", localHostId: local }),
    ).toBe("Devbox");
  });

  it("falls back to the id rather than showing an empty name", () => {
    expect(environmentLabel({ hostId: devbox, hostDisplayName: "   " })).toBe(devbox);
    expect(environmentLabel({ hostId: devbox })).toBe(devbox);
  });
});

describe("listing the environments a filter offers", () => {
  it("puts Local first and the rest by name", () => {
    const rows = environmentRows({
      hostStates: hostStates(),
      selection: ALL_ENVIRONMENTS,
      localHostId: local,
    });

    expect(rows.map((row) => row.label)).toEqual(["Local", "Aero", "Devbox"]);
  });

  it("keeps an unreachable environment on the list rather than hiding it", () => {
    const rows = environmentRows({
      hostStates: hostStates({ [devbox]: "unavailable" }),
      selection: ALL_ENVIRONMENTS,
      localHostId: local,
    });

    expect(rows.find((row) => row.hostId === devbox)).toMatchObject({
      reach: "unreachable",
      itemCount: 4,
    });
  });

  it.each([
    ["ready", "ready"],
    ["connecting", "connecting"],
    ["stale", "stale"],
    ["unavailable", "unreachable"],
    ["unauthorized", "unreachable"],
    ["incompatible", "unreachable"],
  ] as const)("reports %s freshness as %s reach", (freshness, reach) => {
    expect(environmentReach(freshness)).toBe(reach);
  });
});

describe("choosing environments", () => {
  it("starts on all, and All means all rather than today's list", () => {
    expect(allEnvironmentsSelected(ALL_ENVIRONMENTS, known)).toBe(true);
    // A host that connects later is included, which a frozen set would exclude.
    expect(allEnvironmentsSelected(ALL_ENVIRONMENTS, [...known, "host-new"])).toBe(true);
  });

  it("unticking one while All is on means everything except that one", () => {
    const next = toggleEnvironment(ALL_ENVIRONMENTS, devbox, known);

    expect(next).toEqual({ kind: "some", hostIds: new Set([local, laptop]) });
  });

  it("ticking the last missing one collapses back to All rather than freezing the set", () => {
    const partial: EnvironmentSelection = { kind: "some", hostIds: new Set([local, laptop]) };

    expect(toggleEnvironment(partial, devbox, known)).toEqual(ALL_ENVIRONMENTS);
  });

  it("unticking the master selects none rather than silently meaning everything", () => {
    const none = toggleAllEnvironments(ALL_ENVIRONMENTS);

    expect(none).toEqual({ kind: "some", hostIds: new Set() });
    expect(toggleAllEnvironments(none)).toEqual(ALL_ENVIRONMENTS);
  });
});

describe("filtering items by environment", () => {
  const items = [item(local, "Local thread"), item(devbox, "Devbox thread")];
  const hostIdOf = (candidate: FederatedReadItem<{ readonly hostId: string }>) =>
    candidate.payload.hostId;

  it("shows everything under All without copying the list", () => {
    expect(selectEnvironmentItems(items, ALL_ENVIRONMENTS, hostIdOf)).toBe(items);
  });

  it("shows only the chosen environments' items", () => {
    expect(
      selectEnvironmentItems(items, { kind: "some", hostIds: new Set([devbox]) }, hostIdOf).map(
        (found) => found.title,
      ),
    ).toEqual(["Devbox thread"]);
  });

  it("keeps a selected but unreachable environment's items rather than making them vanish", () => {
    const stale = [
      item(local, "Local thread"),
      { ...item(devbox, "Devbox thread"), freshness: "stale", readOnly: true },
    ] as ReadonlyArray<FederatedReadItem<{ readonly hostId: string }>>;

    expect(selectEnvironmentItems(stale, ALL_ENVIRONMENTS, hostIdOf)).toHaveLength(2);
  });

  it("shows nothing when nothing is selected", () => {
    expect(selectEnvironmentItems(items, { kind: "some", hostIds: new Set() }, hostIdOf)).toEqual(
      [],
    );
  });
});

describe("summarising the selection", () => {
  const rows = (selection: EnvironmentSelection) =>
    environmentRows({ hostStates: hostStates(), selection, localHostId: local });

  it("names environments while there are few, and counts them when there are many", () => {
    expect(environmentSelectionSummary(rows(ALL_ENVIRONMENTS), ALL_ENVIRONMENTS)).toBe(
      "All environments",
    );

    const two: EnvironmentSelection = { kind: "some", hostIds: new Set([local, devbox]) };
    expect(environmentSelectionSummary(rows(two), two)).toBe("Local, Devbox");

    const three: EnvironmentSelection = { kind: "some", hostIds: new Set(known) };
    expect(environmentSelectionSummary(rows(three), three)).toBe("3 environments");
  });

  it("says plainly when nothing is selected", () => {
    const none: EnvironmentSelection = { kind: "some", hostIds: new Set() };

    expect(environmentSelectionSummary(rows(none), none)).toBe("No environments");
  });
});
