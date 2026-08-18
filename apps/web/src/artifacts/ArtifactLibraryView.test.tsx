import type { ArtifactLibraryListing } from "@octant/contracts/artifact-library";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  render(
    <ArtifactLibraryView
      busy={false}
      filters={INITIAL_ARTIFACT_FILTERS}
      listing={listing}
      observedAt="2026-08-18T09:00:00.000Z"
      {...(options.canCreate === false ? {} : { onCreate })}
      onFiltersChange={onFiltersChange}
      onOpen={onOpen}
      {...overrides}
    />,
  );
  return { onFiltersChange, onOpen, onCreate };
}

describe("the artifact gallery", () => {
  it("shows every artifact with its Project, kind, share state, and when it was edited", () => {
    view();

    const card = screen.getByRole("button", { name: /Launch plan/ });
    expect(within(card).getByText("Storefront · Chart")).toBeInTheDocument();
    expect(within(card).getByText("Shared")).toBeInTheDocument();
    expect(within(card).getByText("Edited 3 hours ago")).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: /Schema map/ })).getByText("Private"),
    ).toBeInTheDocument();
  });

  it("draws the host's preview rather than deriving a second one", () => {
    view();

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

    await user.selectOptions(screen.getByLabelText("Filter by mode"), "code");
    expect(onFiltersChange).toHaveBeenCalledWith({
      tab: "all",
      query: "",
      kind: "chart",
      mode: "code",
    });

    await user.selectOptions(screen.getByLabelText("Filter by kind"), "");
    // Cleared, not set to undefined: the query the host decodes has no room for
    // a field that is explicitly absent.
    expect(onFiltersChange).toHaveBeenLastCalledWith({ tab: "all", query: "" });
  });

  it("offers each Project with how many artifacts it holds", () => {
    view();

    expect(screen.getByRole("option", { name: "Storefront (1)" })).toBeInTheDocument();
  });

  it("groups by Project only on the tab that asks for it", () => {
    view({ filters: { tab: "by-project", query: "" } });

    expect(screen.getByRole("region", { name: "Storefront" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Octant" })).toBeInTheDocument();
  });

  it("opens the artifact the user picked", async () => {
    const user = userEvent.setup();
    const { onOpen } = view();

    await user.click(screen.getByRole("button", { name: /Launch plan/ }));

    expect(onOpen).toHaveBeenCalledWith(listing.entries[0]);
  });

  it("says how much it is not showing when the host cut the list", () => {
    view({
      listing: { ...listing, matchCount: 500, truncated: true } as ArtifactLibraryListing,
    });

    expect(screen.getByText(/Showing 2 of 500/)).toBeInTheDocument();
  });

  it("says plainly when nothing is shared rather than looking broken", () => {
    view({
      filters: { tab: "shared", query: "" },
      listing: { ...listing, entries: [], matchCount: 0 } as ArtifactLibraryListing,
    });

    expect(screen.getByText("Nothing is shared right now.")).toBeInTheDocument();
  });

  it("hides the create action on a host that cannot start a thread", () => {
    view({}, { canCreate: false });

    expect(screen.queryByRole("button", { name: "New artifact" })).not.toBeInTheDocument();
  });
});
