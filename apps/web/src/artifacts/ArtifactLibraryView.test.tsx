import type { ArtifactLibraryListing } from "@octant/contracts/artifact-library";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactLibraryView } from "./ArtifactLibraryView";
import { INITIAL_ARTIFACT_FILTERS, type ArtifactLibraryFilters } from "./useArtifactLibrary";

const listing = {
  kind: "artifact-library-listing",
  entries: [
    {
      canvasId: "10000000-0000-4000-8000-00000000000a",
      projectId: "20000000-0000-4000-8000-000000000001",
      projectName: "Storefront",
      mode: "work",
      kind: "chart",
      title: "Launch plan",
      versionCount: 3,
      currentVersionId: "30000000-0000-4000-8000-000000000001",
      currentSequence: 3,
      updatedAt: "2026-08-18T06:00:00.000Z",
      shared: true,
      tags: ["Launch"],
      preview: { format: "svg", markup: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    },
    {
      canvasId: "10000000-0000-4000-8000-00000000000b",
      projectId: "20000000-0000-4000-8000-000000000002",
      projectName: "Octant",
      mode: "code",
      kind: "diagram",
      title: "Schema map",
      versionCount: 1,
      currentVersionId: "30000000-0000-4000-8000-000000000002",
      currentSequence: 1,
      updatedAt: "2026-08-15T09:00:00.000Z",
      shared: false,
    },
  ],
  projects: [
    {
      projectId: "20000000-0000-4000-8000-000000000002",
      name: "Octant",
      mode: "code",
      artifactCount: 1,
    },
    {
      projectId: "20000000-0000-4000-8000-000000000001",
      name: "Storefront",
      mode: "work",
      artifactCount: 1,
    },
  ],
  tags: [{ name: "Launch", artifactCount: 1 }],
  matchCount: 2,
  truncated: false,
  generatedAt: "2026-08-18T09:00:00.000Z",
} as unknown as ArtifactLibraryListing;

function view(
  overrides: Partial<Parameters<typeof ArtifactLibraryView>[0]> = {},
  options: { readonly canCreate?: boolean } = {},
) {
  const onFiltersChange = vi.fn();
  const onOpen = vi.fn();
  const onCreate = vi.fn();
  const onViewChange = vi.fn();
  render(
    <ArtifactLibraryView
      busy={false}
      filters={INITIAL_ARTIFACT_FILTERS}
      listing={listing}
      observedAt="2026-08-18T09:00:00.000Z"
      view="gallery"
      {...(options.canCreate === false ? {} : { onCreate })}
      onFiltersChange={onFiltersChange}
      onOpen={onOpen}
      onViewChange={onViewChange}
      {...overrides}
    />,
  );
  return { onFiltersChange, onOpen, onCreate, onViewChange };
}

describe("the artifact gallery", () => {
  it("opens grouped by Project, with the flat All one click away", () => {
    expect(INITIAL_ARTIFACT_FILTERS.tab).toBe("by-project");
    view();

    expect(screen.getByRole("region", { name: "Storefront" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Octant" })).toBeInTheDocument();
  });

  it("shows every artifact with its Project, kind, share state, and when it was edited", () => {
    view({ filters: { tab: "all", query: "" } });

    const card = screen.getByRole("button", { name: /Launch plan/ });
    expect(within(card).getByText("Storefront · Chart")).toBeInTheDocument();
    expect(within(card).getByText("Shared")).toBeInTheDocument();
    expect(within(card).getByText("Edited 3 hours ago")).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: /Schema map/ })).getByText("Private"),
    ).toBeInTheDocument();
  });

  it("draws the host's preview rather than deriving a second one", () => {
    view({ filters: { tab: "all", query: "" } });

    expect(document.querySelector(".artifact-card__preview-svg svg")).not.toBeNull();
    // An artifact the host could not draw says what kind it is instead of
    // showing a broken picture.
    expect(
      screen.getByText("Diagram", { selector: ".artifact-card__preview-fallback" }),
    ).toBeInTheDocument();
  });

  it("asks the host for the tab the user picked rather than filtering what it has", () => {
    const { onFiltersChange } = view();

    screen.getByRole("tab", { name: "Shared" }).click();

    expect(onFiltersChange).toHaveBeenCalledWith({ tab: "shared", query: "" });
  });

  it("sends every filter to the host, and clears one by removing it", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = view({
      filters: { tab: "all", query: "", kind: "chart" } as ArtifactLibraryFilters,
    });

    await user.click(screen.getByLabelText("Filter by mode"));
    await user.click(await screen.findByRole("option", { name: "Code" }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      tab: "all",
      query: "",
      kind: "chart",
      mode: "code",
    });

    await user.click(screen.getByLabelText("Filter by kind"));
    await user.click(await screen.findByRole("option", { name: "Any kind" }));
    // Cleared, not set to undefined: the query the host decodes has no room for
    // a field that is explicitly absent.
    expect(onFiltersChange).toHaveBeenLastCalledWith({ tab: "all", query: "" });
  });

  it("filters by the person's tags and clears the choice the same way", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = view({ filters: { tab: "all", query: "" } });

    await user.click(screen.getByLabelText("Filter by tag"));
    await user.click(await screen.findByRole("option", { name: "Launch (1)" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      tab: "all",
      query: "",
      tag: "Launch",
    });

    await user.click(screen.getByLabelText("Filter by tag"));
    await user.click(await screen.findByRole("option", { name: "Any tag" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ tab: "all", query: "" });
  });

  it("offers each Project with how many artifacts it holds", async () => {
    const user = userEvent.setup();
    view();

    await user.click(screen.getByLabelText("Filter by Project"));
    expect(await screen.findByRole("option", { name: "Storefront (1)" })).toBeInTheDocument();
  });

  it("groups by Project only on the tab that asks for it", () => {
    view();

    expect(screen.getByRole("region", { name: "Storefront" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Octant" })).toBeInTheDocument();
  });

  it("leaves the flat All tab flat", () => {
    view({ filters: { tab: "all", query: "" } });

    expect(screen.queryByRole("region", { name: "Storefront" })).not.toBeInTheDocument();
  });

  it("groups by tag, and gathers what carries none at the end", () => {
    view({ filters: { tab: "by-tag", query: "" } });

    const launch = screen.getByRole("region", { name: "Launch" });
    expect(within(launch).getByRole("button", { name: /Launch plan/ })).toBeInTheDocument();
    const none = screen.getByRole("region", { name: "No tags" });
    expect(within(none).getByRole("button", { name: /Schema map/ })).toBeInTheDocument();
  });

  it("names no Project for a Canvas a Chat thread owns, and files it under No Project", () => {
    const threadOwned = {
      ...listing,
      entries: [
        {
          canvasId: "10000000-0000-4000-8000-00000000000e",
          mode: "chat",
          kind: "document",
          title: "Trip notes",
          versionCount: 1,
          currentVersionId: "30000000-0000-4000-8000-00000000000e",
          currentSequence: 1,
          updatedAt: "2026-08-18T08:00:00.000Z",
          shared: false,
        },
      ],
      matchCount: 1,
    } as unknown as ArtifactLibraryListing;
    view({ listing: threadOwned });

    const group = screen.getByRole("region", { name: "No Project" });
    expect(within(group).getByText("No Project · Document")).toBeInTheDocument();
  });

  it("opens the artifact the user picked", async () => {
    const user = userEvent.setup();
    const { onOpen } = view({ filters: { tab: "all", query: "" } });

    await user.click(screen.getByRole("button", { name: /Launch plan/ }));

    expect(onOpen).toHaveBeenCalledWith(listing.entries[0]);
  });

  it("says how much it is not showing when the host cut the list", () => {
    view({
      filters: { tab: "all", query: "" },
      listing: { ...listing, matchCount: 500, truncated: true } as ArtifactLibraryListing,
    });

    expect(screen.getByText(/Showing 2 of 500/)).toBeInTheDocument();
  });

  it("uses the shared empty state and offers a way back when nothing is shared", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = view({
      filters: { tab: "shared", query: "" },
      listing: { ...listing, entries: [], matchCount: 0 } as ArtifactLibraryListing,
    });

    const title = screen.getByText("Nothing is shared right now.");
    expect(title.closest("[role='status']")).toHaveClass("surface-empty");
    expect(screen.getByText("Artifacts you share will appear here.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View all artifacts" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ tab: "all", query: "" });
  });

  it("hides the create action on a host that cannot start a thread", () => {
    view({}, { canCreate: false });

    expect(screen.queryByRole("button", { name: "New artifact" })).not.toBeInTheDocument();
  });
});

describe("choosing how the page reads", () => {
  // The view is the window's own state, so the harness holds it the way the
  // surface does: the toggle re-renders through onViewChange.
  function renderView(initial: "gallery" | "list", filters: ArtifactLibraryFilters) {
    const onViewChange = vi.fn();
    function Harness() {
      const [view, setView] = useState(initial);
      return (
        <ArtifactLibraryView
          busy={false}
          filters={filters}
          listing={listing}
          observedAt="2026-08-18T09:00:00.000Z"
          view={view}
          onViewChange={(next) => {
            onViewChange(next);
            setView(next);
          }}
          onFiltersChange={vi.fn()}
          onOpen={vi.fn()}
        />
      );
    }
    render(<Harness />);
    return { onViewChange };
  }

  it("switches to compact rows and says so to the window, not the host", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderView("gallery", { tab: "all", query: "" });

    await user.click(screen.getByRole("button", { name: "List view" }));

    expect(onViewChange).toHaveBeenCalledWith("list");
    expect(document.querySelector(".artifact-row")).not.toBeNull();
    expect(document.querySelector(".artifact-card")).toBeNull();
  });

  it("keeps grouped sections in the list view too", async () => {
    const user = userEvent.setup();
    renderView("gallery", { tab: "by-project", query: "" });
    await user.click(screen.getByRole("button", { name: "List view" }));

    const group = screen.getByRole("region", { name: "Storefront" });
    expect(within(group).getByRole("button", { name: /Launch plan/ })).toBeInTheDocument();
  });

  it("returns to the gallery of preview cards", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderView("list", { tab: "all", query: "" });

    await user.click(screen.getByRole("button", { name: "Gallery view" }));

    expect(onViewChange).toHaveBeenCalledWith("gallery");
    expect(document.querySelector(".artifact-card")).not.toBeNull();
  });
});

describe("the person's own tags", () => {
  it("shows the tags an artifact carries and removes one on its chip", async () => {
    const user = userEvent.setup();
    const onTagRemove = vi.fn();
    view({
      filters: { tab: "all", query: "" },
      onTagRemove,
    });

    await user.click(screen.getByRole("button", { name: "Remove tag Launch" }));

    expect(onTagRemove).toHaveBeenCalledWith("10000000-0000-4000-8000-00000000000a", "Launch");
  });

  it("adds a tag from the card and the row alike", async () => {
    const user = userEvent.setup();
    const onTagAdd = vi.fn();
    view({ filters: { tab: "all", query: "" }, onTagAdd });

    await user.click(screen.getAllByRole("button", { name: /^Tag$/ })[0]!);
    await user.type(screen.getByLabelText("Tag name"), "Q4");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onTagAdd).toHaveBeenCalledWith("10000000-0000-4000-8000-00000000000a", "Q4");
  });

  it("offers no way to change a tag where the surface cannot", () => {
    view({ filters: { tab: "all", query: "" } });

    expect(screen.queryByRole("button", { name: /^Tag$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove tag/ })).not.toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
  });
});

describe("artifacts synced across this person's computers", () => {
  const syncedListing = {
    ...listing,
    entries: [
      {
        ...listing.entries[0],
        writtenOn: "Studio Mac",
        syncStatus: "two-versions",
      },
      { ...listing.entries[1], writtenOn: "MacBook Air" },
    ],
    synced: [
      {
        canvasId: "10000000-0000-4000-8000-00000000000c",
        projectName: "Field notes",
        computerName: "Studio Mac",
        mode: "work",
        kind: "document",
        title: "Pricing notes",
        versionCount: 2,
        headCount: 1,
        status: "deleted",
        deletedOn: "Studio Mac",
        updatedAt: "2026-08-18T08:00:00.000Z",
      },
      {
        canvasId: "10000000-0000-4000-8000-00000000000d",
        projectName: "Field notes",
        computerName: "Mac mini",
        mode: "work",
        kind: "document",
        title: "Interview log",
        versionCount: 1,
        headCount: 1,
        status: "current",
        updatedAt: "2026-08-18T07:00:00.000Z",
      },
    ],
  } as unknown as ArtifactLibraryListing;

  it("names the computer that wrote each card's version", () => {
    view({
      listing: syncedListing,
      filters: { tab: "all", query: "" },
      onSync: vi.fn(),
      onRestore: vi.fn(),
    });
    expect(screen.getByText("Written on MacBook Air")).toBeTruthy();
    const fromElsewhere = screen.getByRole("region", { name: "From your other computers" });
    expect(within(fromElsewhere).getByText("Written on Mac mini")).toBeTruthy();
    expect(within(fromElsewhere).getAllByText("Field notes · Document")).toHaveLength(2);
  });

  it("shows Two versions with a way to choose, and Deleted on a computer with Restore", async () => {
    const onSync = vi.fn();
    const onRestore = vi.fn();
    view({
      listing: syncedListing,
      filters: { tab: "all", query: "" },
      onSync,
      onRestore,
    });

    expect(screen.getByText("Two versions")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Choose between the two versions of Launch plan" }),
    );
    expect(onSync).toHaveBeenCalledWith("10000000-0000-4000-8000-00000000000a");

    expect(screen.getByText("Deleted on Studio Mac")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Restore Pricing notes" }));
    expect(onRestore).toHaveBeenCalledWith("10000000-0000-4000-8000-00000000000c");

    // A current artifact says nothing about sync beyond who wrote it.
    expect(screen.queryByRole("button", { name: "Restore Interview log" })).toBeNull();
    expect(screen.getAllByText(/^Two versions$/)).toHaveLength(1);
  });

  it("shows nothing about other computers on a host without artifact sync", () => {
    view({ listing: syncedListing, filters: { tab: "all", query: "" } });
    expect(screen.queryByRole("region", { name: "From your other computers" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Choose between/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Versions of/ })).toBeNull();
  });
});
