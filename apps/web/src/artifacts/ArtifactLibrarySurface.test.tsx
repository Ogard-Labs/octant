import type { ArtifactLibraryListing } from "@octant/contracts/artifact-library";
import type { CanvasTagCommandResult } from "@octant/contracts/canvas-tags";
import type { CanvasExportOfferList } from "@octant/contracts/canvas-export";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_ARTIFACT_FILTERS } from "./useArtifactLibrary";

const exportOffers = vi.fn<(canvasId: string) => Promise<CanvasExportOfferList>>();

const prepareExport = vi.fn();

const changeTag = vi.fn<(command: unknown) => Promise<CanvasTagCommandResult>>();

const refreshLibrary = vi.fn();

vi.mock("@octant/client-runtime/canvas-client", () => ({
  createCanvasClient: () => ({
    exportOffers,
    prepareExport,
    decideExport: vi.fn(),
  }),
}));

vi.mock("@octant/client-runtime/artifact-library-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octant/client-runtime/artifact-library-client")>()),
  // The real client takes (options, command); only the command is asserted.
  changeArtifactTag: (options: unknown, command: unknown) => changeTag(command),
}));

vi.mock("./useArtifactLibrary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useArtifactLibrary")>()),
  useArtifactLibrary: () => ({
    listing,
    filters: INITIAL_ARTIFACT_FILTERS,
    setFilters: vi.fn(),
    busy: false,
    message: undefined,
    refresh: refreshLibrary,
  }),
}));

vi.mock("./useArtifactMirror", () => ({
  useArtifactMirror: () => ({
    settings: undefined,
    projects: [],
    busy: false,
    message: undefined,
    changeAutoCommit: vi.fn(),
    changeDestination: vi.fn(),
    chooseFolderAgain: vi.fn(),
  }),
}));

import { ArtifactLibrarySurface } from "./ArtifactLibrarySurface";

const firstCanvasId = "10000000-0000-4000-8000-00000000000a";
const secondCanvasId = "10000000-0000-4000-8000-00000000000b";
const deletedCanvasId = "10000000-0000-4000-8000-00000000000c";
const syncedCanvasId = "10000000-0000-4000-8000-00000000000d";

function entry(canvasId: string, title: string) {
  return {
    canvasId,
    projectId: "20000000-0000-4000-8000-000000000001",
    projectName: "Storefront",
    mode: "work",
    kind: "document",
    title,
    versionCount: 1,
    currentVersionId: "30000000-0000-4000-8000-000000000001",
    currentSequence: 1,
    updatedAt: "2026-08-18T06:00:00.000Z",
    shared: false,
    // The person's own filing on the first artifact, so a remove path exists
    // without the add having to run first.
    ...(canvasId === firstCanvasId ? { tags: ["Q4"] } : {}),
  };
}

const listing = {
  kind: "artifact-library-listing",
  entries: [entry(firstCanvasId, "Launch plan"), entry(secondCanvasId, "Schema map")],
  synced: [
    {
      canvasId: deletedCanvasId,
      projectName: "Field notes",
      computerName: "Studio Mac",
      mode: "work",
      kind: "document",
      title: "Pricing notes",
      versionCount: 1,
      headCount: 1,
      status: "deleted",
      deletedOn: "Studio Mac",
      updatedAt: "2026-08-18T08:00:00.000Z",
    },
    {
      canvasId: syncedCanvasId,
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
  projects: [],
  matchCount: 2,
  truncated: false,
  generatedAt: "2026-08-18T09:00:00.000Z",
} as unknown as ArtifactLibraryListing;

function offersFor(
  canvasId: string,
  label: string,
  formats: ReadonlyArray<string> = ["markdown"],
): CanvasExportOfferList {
  return {
    schemaVersion: 1,
    kind: "canvas-export-offers",
    canvasId,
    versionId: "30000000-0000-4000-8000-000000000001",
    sequence: 1,
    targets: [{ targetId: "reading-copy", label, formats, status: "ready" }],
  } as unknown as CanvasExportOfferList;
}

describe("ArtifactLibrarySurface export", () => {
  beforeEach(() => {
    exportOffers.mockReset();
    prepareExport.mockReset();
  });

  it("sends the workspace theme when a picture export of an artifact is reviewed", async () => {
    exportOffers.mockResolvedValue(offersFor(firstCanvasId, "Pictures", ["png"]));
    prepareExport.mockResolvedValue({ kind: "refused", code: "refused", message: "Not now." });
    const user = userEvent.setup();
    render(
      <ArtifactLibrarySurface
        onClose={vi.fn()}
        onOpen={vi.fn()}
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "Export…" })[0] as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "Review export" }));

    await waitFor(() => expect(prepareExport).toHaveBeenCalledTimes(1));
    expect(prepareExport.mock.calls[0]?.[0]).toMatchObject({
      format: "png",
      frameTheme: { scheme: expect.stringMatching(/^(light|dark)$/) },
    });
  });

  it("shows the destinations of the artifact asked about last when an older answer arrives late", async () => {
    const resolvers = new Map<string, (offers: CanvasExportOfferList) => void>();
    exportOffers.mockImplementation(
      (canvasId) =>
        new Promise((resolve) => {
          resolvers.set(canvasId, resolve);
        }),
    );
    const user = userEvent.setup();
    render(
      <ArtifactLibrarySurface
        onClose={vi.fn()}
        onOpen={vi.fn()}
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );

    const buttons = screen.getAllByRole("button", { name: "Export…" });
    await user.click(buttons[0] as HTMLElement);
    await user.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(resolvers.size).toBe(2));

    await act(async () => {
      resolvers.get(secondCanvasId)?.(offersFor(secondCanvasId, "Second copy"));
    });
    await screen.findAllByText("Second copy");
    await act(async () => {
      resolvers.get(firstCanvasId)?.(offersFor(firstCanvasId, "First copy"));
    });

    expect(screen.queryByText("First copy")).toBeNull();
    expect(screen.getAllByText("Second copy").length).toBeGreaterThan(0);
  });
});

describe("ArtifactLibrarySurface tags", () => {
  beforeEach(() => {
    changeTag.mockReset();
    refreshLibrary.mockClear();
  });

  function surface() {
    render(
      <ArtifactLibrarySurface
        onClose={vi.fn()}
        onOpen={vi.fn()}
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );
  }

  /** The card that opens an artifact, found by the artifact it opens. */
  function cardOf(title: string) {
    const open = screen.getByRole("button", { name: new RegExp(title) });
    const card = open.closest("li");
    if (card === null) throw new Error(`expected a card for ${title}`);
    return card;
  }

  it("sends the tag the person typed to the host and refreshes the listing", async () => {
    changeTag.mockResolvedValue({
      kind: "accepted",
      canvasId: firstCanvasId as never,
      sequence: 2,
      tags: ["Q4", "Launch"],
    });
    const user = userEvent.setup();
    surface();

    const card = cardOf("Launch plan");
    await user.click(within(card).getByRole("button", { name: "Tag" }));
    await user.type(within(card).getByLabelText("Tag name"), "Launch");
    await user.click(within(card).getByRole("button", { name: "Add" }));

    expect(changeTag).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "canvas-tag-add",
        canvasId: firstCanvasId,
        tag: "Launch",
        issuedAt: expect.any(String),
      }),
    );
    await waitFor(() => expect(refreshLibrary).toHaveBeenCalled());
  });

  it("removes a tag through its chip and refreshes the listing", async () => {
    changeTag.mockResolvedValue({
      kind: "accepted",
      canvasId: firstCanvasId as never,
      sequence: 2,
      tags: [],
    });
    const user = userEvent.setup();
    surface();

    await user.click(screen.getByRole("button", { name: "Remove tag Q4" }));

    expect(changeTag).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "canvas-tag-remove",
        canvasId: firstCanvasId,
        tag: "Q4",
        issuedAt: expect.any(String),
      }),
    );
    await waitFor(() => expect(refreshLibrary).toHaveBeenCalled());
  });

  it("shows the host's refusal beside the page rather than as a failure", async () => {
    changeTag.mockResolvedValue({
      kind: "denied",
      denialCode: "duplicate-tag",
      message: "Canvas already carries this tag.",
    });
    const user = userEvent.setup();
    surface();

    const card = cardOf("Launch plan");
    await user.click(within(card).getByRole("button", { name: "Tag" }));
    await user.type(within(card).getByLabelText("Tag name"), "Launch");
    await user.click(within(card).getByRole("button", { name: "Add" }));

    const refusal = await screen.findByText("Canvas already carries this tag.");
    expect(refusal.closest("[role='status']")).not.toBeNull();
    expect(refreshLibrary).not.toHaveBeenCalled();
  });
});

describe("ArtifactLibrarySurface synced artifacts", () => {
  it("restores a deleted artifact from its card and says what happened", async () => {
    const execute = vi.fn(async () => ({
      kind: "artifact-synced-published" as const,
      canvasId: deletedCanvasId as never,
      versionId: "30000000-0000-4000-8000-0000000000ff" as never,
      published: false,
    }));
    const user = userEvent.setup();
    render(
      <ArtifactLibrarySurface
        execute={execute}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restore Pricing notes" }));
    expect(execute).toHaveBeenCalledWith(expect.anything(), {
      kind: "restore",
      canvasId: deletedCanvasId,
    });
    expect(
      await screen.findByText(
        "Done here. It goes to your other computers once the store can be reached.",
      ),
    ).toBeTruthy();
  });

  it("opens a synced artifact in the thread chosen and shows it", async () => {
    const opened = entry(syncedCanvasId, "Interview log");
    const execute = vi.fn(async (_options: unknown, command: { kind: string }) =>
      command.kind === "detail"
        ? ({
            kind: "artifact-synced-detail",
            canvasId: syncedCanvasId,
            title: "Interview log",
            projectName: "Field notes",
            mode: "work",
            status: "current",
            openHere: false,
            versions: [],
            threads: [
              {
                threadId: "40000000-0000-4000-8000-000000000001",
                mode: "work",
                projectId: "50000000-0000-4000-8000-000000000001",
                projectName: "Storefront",
                title: "Research",
              },
            ],
          } as never)
        : ({ kind: "artifact-synced-opened", entry: opened } as never),
    );
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(
      <ArtifactLibrarySurface
        execute={execute}
        onClose={vi.fn()}
        onOpen={onOpen}
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Interview log, from Mac mini" }));
    await user.click(await screen.findByRole("button", { name: "Open" }));
    expect(execute).toHaveBeenLastCalledWith(expect.anything(), {
      kind: "open",
      canvasId: syncedCanvasId,
      threadId: "40000000-0000-4000-8000-000000000001",
    });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(opened));
  });
});
