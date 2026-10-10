import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  canvasInventoryProjectId,
  quarterlyCanvasId,
  quarterlyInventoryEntry,
} from "../projects/canvasInventoryFixtures";
import { RIGHT_UTILITY_DOCK_SURFACES } from "../shell/rightUtilityDockModel";
import { RightUtilityDock } from "../shell/RightUtilityDock";
import { CanvasWorkspaceTab } from "./CanvasWorkspaceTab";
import { canvasFixture } from "./test-fixtures";

const skillDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const canvasTab = {
  kind: "canvas" as const,
  id: "55555555-5555-4555-8555-555555555555" as never,
  mode: "chat" as const,
  title: quarterlyInventoryEntry.title,
  canvasId: quarterlyCanvasId,
  projectId: canvasInventoryProjectId,
};

const workRootId = "77777777-7777-4777-8777-777777777777";
const workThreadId = "12121212-1212-4212-8212-121212121212";

const readyVersion = {
  kind: "ready" as const,
  workspace: { kind: "chat-virtual" as const, projectId: null },
  version: {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: quarterlyCanvasId,
    versionId: quarterlyInventoryEntry.currentVersionId,
    sequence: quarterlyInventoryEntry.currentSequence,
    definition: canvasFixture,
    createdBy: {
      kind: "local-user" as const,
      actorId: "88888888-8888-4888-8888-888888888888" as never,
    },
    createdAt: "2026-08-01T21:00:00.000Z" as never,
  },
};

function createCanvasClient(
  outcome: Awaited<ReturnType<CanvasClient["get"]>>,
  historyOutcome?: Awaited<ReturnType<CanvasClient["history"]>>,
  overrides?: Partial<CanvasClient>,
): CanvasClient {
  return {
    inventory: vi.fn(),
    get: vi.fn(async () => outcome),
    history: vi.fn(
      async () =>
        historyOutcome ?? {
          kind: "ready",
          history: {
            canvasId: quarterlyCanvasId,
            currentVersionId: quarterlyInventoryEntry.currentVersionId,
            entries: [
              {
                versionId: quarterlyInventoryEntry.currentVersionId,
                sequence: quarterlyInventoryEntry.currentSequence,
                schemaVersion: 1,
                title: quarterlyInventoryEntry.title,
                createdAt: "2026-08-01T21:00:00.000Z",
                createdBy: {
                  kind: "local-user",
                  actorId: "88888888-8888-4888-8888-888888888888" as never,
                },
                providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
                modelId: "octant-test-model",
              },
            ],
          },
        },
    ),
    revise: vi.fn(),
    create: vi.fn(),
    threadReferenceCards: vi.fn(),
    ...overrides,
  } as CanvasClient;
}

async function openVersionHistory() {
  fireEvent.click(await screen.findByRole("button", { name: /^Version history/ }));
}

async function openCanvasTool(label: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "More Canvas actions" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

describe("CanvasWorkspaceTab", () => {
  it("renders the authorized canvas definition when get returns ready", async () => {
    render(<CanvasWorkspaceTab tab={canvasTab} client={createCanvasClient(readyVersion)} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Canvas unavailable")).not.toBeInTheDocument();
  });

  it("shows an unavailable placeholder when the projection row is missing", async () => {
    render(
      <CanvasWorkspaceTab
        tab={canvasTab}
        client={createCanvasClient({
          kind: "unavailable",
          canvasId: quarterlyCanvasId,
          reason: "Canvas is no longer available in this Project.",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Canvas unavailable")).toBeInTheDocument();
      expect(
        screen.getByText("Canvas is no longer available in this Project."),
      ).toBeInTheDocument();
      expect(screen.getByText(quarterlyInventoryEntry.title)).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Signed Q3 report" })).not.toBeInTheDocument();
  });

  it("fails closed when the host canvas client is unavailable", () => {
    render(<CanvasWorkspaceTab tab={canvasTab} client={undefined} />);
    expect(screen.getByText("The host canvas client is unavailable.")).toBeInTheDocument();
  });

  it("exposes focus-zone pin and attach-context actions when handlers are provided", async () => {
    const onPinCanvasInFocusZone = vi.fn();
    const onAttachContext = vi.fn();

    render(
      <CanvasWorkspaceTab
        tab={canvasTab}
        client={createCanvasClient(readyVersion)}
        onAttachContext={onAttachContext}
        onPinCanvasInFocusZone={onPinCanvasInFocusZone}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Pin Quarterly summary in the focus zone/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Pin Quarterly summary in the focus zone/i }),
    );
    expect(onPinCanvasInFocusZone).toHaveBeenCalledWith({
      canvasId: quarterlyCanvasId,
      title: "Signed Q3 report",
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Attach Signed Q3 report to thread context/i }),
    );
    expect(onAttachContext).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: quarterlyCanvasId,
        displayName: "Signed Q3 report",
        scope: "whole-canvas",
        sequence: quarterlyInventoryEntry.currentSequence,
        versionId: quarterlyInventoryEntry.currentVersionId,
      }),
    );
  });

  it("discards a superseded version selection when responses arrive out of order", async () => {
    type GetOutcome = Awaited<ReturnType<CanvasClient["get"]>>;
    const olderVersionId = "22222222-2222-4222-8222-222222222222";
    const currentVersionId = String(quarterlyInventoryEntry.currentVersionId);
    const olderVersion: GetOutcome = {
      ...readyVersion,
      version: {
        ...readyVersion.version,
        versionId: olderVersionId as never,
        sequence: 1,
        definition: { ...canvasFixture, title: "Draft Q3 report" },
      },
    } as GetOutcome;
    const resolvers = new Map<string, (outcome: GetOutcome) => void>();
    const get = vi.fn((_canvasId: unknown, versionId?: string) => {
      if (versionId === undefined) return Promise.resolve(readyVersion as GetOutcome);
      return new Promise<GetOutcome>((resolve) => {
        resolvers.set(versionId, resolve);
      });
    });
    const historyEntryBase = {
      schemaVersion: 1,
      title: quarterlyInventoryEntry.title,
      createdAt: "2026-08-01T21:00:00.000Z",
      createdBy: {
        kind: "local-user" as const,
        actorId: "88888888-8888-4888-8888-888888888888" as never,
      },
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
      modelId: "octant-test-model",
    };
    const historyOutcome = {
      kind: "ready",
      history: {
        canvasId: quarterlyCanvasId,
        currentVersionId: quarterlyInventoryEntry.currentVersionId,
        entries: [
          {
            ...historyEntryBase,
            versionId: quarterlyInventoryEntry.currentVersionId,
            sequence: quarterlyInventoryEntry.currentSequence,
          },
          { ...historyEntryBase, versionId: olderVersionId as never, sequence: 1 },
        ],
      },
    } as unknown as Awaited<ReturnType<CanvasClient["history"]>>;
    const onAttachContext = vi.fn();

    render(
      <CanvasWorkspaceTab
        tab={canvasTab}
        client={createCanvasClient(readyVersion, historyOutcome, {
          get,
        } as unknown as Partial<CanvasClient>)}
        onAttachContext={onAttachContext}
      />,
    );

    // Two quick selections: first the older version, then back to the tip.
    await openVersionHistory();
    fireEvent.click(await screen.findByTestId("canvas-version-1"));
    await openVersionHistory();
    fireEvent.click(
      await screen.findByTestId(`canvas-version-${quarterlyInventoryEntry.currentSequence}`),
    );

    // The later selection answers first; the abandoned earlier one straggles
    // in last and must not win.
    await act(async () => {
      resolvers.get(currentVersionId)?.(readyVersion as GetOutcome);
    });
    await act(async () => {
      resolvers.get(olderVersionId)?.(olderVersion);
    });

    expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Draft Q3 report" })).toBeNull();

    // Attach reads the same state share does; it must target the version the
    // user actually has selected.
    fireEvent.click(
      screen.getByRole("button", { name: /Attach Signed Q3 report to thread context/i }),
    );
    expect(onAttachContext).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: quarterlyInventoryEntry.currentVersionId,
        sequence: quarterlyInventoryEntry.currentSequence,
      }),
    );
  });

  it("starts a plan task as a prefilled draft in the Canvas's Project, never as a created thread", async () => {
    const user = userEvent.setup();
    const planVersion = {
      ...readyVersion,
      version: {
        ...readyVersion.version,
        definition: {
          ...canvasFixture,
          blocks: [
            {
              blockId: "plan-1",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "plan" as const,
              title: "Launch plan",
              phases: [{ phaseId: "build", title: "Build" }],
              tasks: [
                {
                  taskId: "docs",
                  phaseId: "build",
                  title: "Write the docs",
                  status: "todo" as const,
                  notes: "The setup guide covers sync.",
                },
                { taskId: "api", phaseId: "build", title: "Ship the API", status: "done" as const },
              ],
            },
          ],
        },
      },
    } as unknown as Awaited<ReturnType<CanvasClient["get"]>>;
    const onStartPlanTask = vi.fn();
    const client = createCanvasClient(planVersion);
    const { unmount } = render(
      <CanvasWorkspaceTab
        client={client}
        onStartPlanTask={onStartPlanTask}
        tab={{ ...canvasTab, mode: "work" }}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Start Write the docs in a new thread" }),
    );
    expect(onStartPlanTask).toHaveBeenCalledWith({
      mode: "work",
      projectId: canvasInventoryProjectId,
      prompt:
        'Work on this task from the plan "Launch plan": Write the docs\nDone when: The setup guide covers sync.',
    });
    // A done task has nothing to start, and starting writes nothing to the Canvas.
    expect(screen.queryByRole("button", { name: "Start Ship the API in a new thread" })).toBeNull();
    expect(client.revise).not.toHaveBeenCalled();
    unmount();

    render(
      <CanvasWorkspaceTab client={client} onStartPlanTask={onStartPlanTask} tab={canvasTab} />,
    );
    await screen.findByText("Write the docs");
    expect(screen.queryByRole("button", { name: /in a new thread$/ })).toBeNull();
  });

  it("journals a node drag as a new version and reloads the board it produced", async () => {
    const reviseDiagramLayout = vi.fn<NonNullable<CanvasClient["reviseDiagramLayout"]>>(
      async () => ({
        kind: "accepted" as const,
        canvasId: quarterlyCanvasId,
        versionId: "56565656-5656-4656-8656-565656565656" as never,
        sequence: quarterlyInventoryEntry.currentSequence + 1,
      }),
    );
    const client = createCanvasClient(readyVersion, undefined, { reviseDiagramLayout });
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    const node = await screen.findByRole("button", { name: "Report" });

    fireEvent.pointerDown(node, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(node, { clientX: 110, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(node, { clientX: 110, clientY: 10, pointerId: 1 });

    await waitFor(() => expect(reviseDiagramLayout).toHaveBeenCalledTimes(1));
    const command = reviseDiagramLayout.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      kind: "canvas-diagram-layout-revise",
      canvasId: quarterlyCanvasId,
      blockId: "diagram-1",
      expectedSequence: quarterlyInventoryEntry.currentSequence,
      // The person's drag, never the creating agent's provenance.
      actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
      positions: [expect.objectContaining({ nodeId: "b" })],
    });
    // Reloaded: the board the host now holds, plus its history.
    await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
    expect(client.history).toHaveBeenCalledTimes(2);
  });

  it("reloads and explains when a drag targets a version the host has moved past", async () => {
    const reviseDiagramLayout = vi.fn(async () => ({
      kind: "denied" as const,
      denialCode: "stale-version" as const,
      message: "Canvas diagram layout revision targets a stale Canvas sequence.",
    }));
    const client = createCanvasClient(readyVersion, undefined, { reviseDiagramLayout });
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    const node = await screen.findByRole("button", { name: "Report" });
    node.focus();
    fireEvent.keyDown(node, { key: "ArrowRight" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the host/);
    await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
  });

  it("keeps a board read-only while an older version is selected", async () => {
    const reviseDiagramLayout = vi.fn();
    const olderVersionId = "45454545-4545-4545-8545-454545454545";
    const client = createCanvasClient(
      readyVersion,
      {
        kind: "ready",
        history: {
          canvasId: quarterlyCanvasId,
          currentVersionId: quarterlyInventoryEntry.currentVersionId,
          entries: [
            {
              versionId: olderVersionId as never,
              sequence: 1,
              schemaVersion: 1,
              title: quarterlyInventoryEntry.title,
              createdAt: "2026-08-01T20:00:00.000Z" as never,
              createdBy: {
                kind: "local-user",
                actorId: "88888888-8888-4888-8888-888888888888" as never,
              },
              providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
              modelId: "octant-test-model" as never,
            },
            {
              versionId: quarterlyInventoryEntry.currentVersionId,
              sequence: quarterlyInventoryEntry.currentSequence,
              schemaVersion: 1,
              title: quarterlyInventoryEntry.title,
              createdAt: "2026-08-01T21:00:00.000Z" as never,
              createdBy: {
                kind: "local-user",
                actorId: "88888888-8888-4888-8888-888888888888" as never,
              },
              providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
              modelId: "octant-test-model" as never,
            },
          ],
        },
      },
      {
        reviseDiagramLayout,
        get: vi.fn(async (_canvasId, versionId) =>
          versionId === olderVersionId
            ? {
                ...readyVersion,
                version: {
                  ...readyVersion.version,
                  versionId: olderVersionId as never,
                  sequence: 1,
                },
              }
            : readyVersion,
        ),
      },
    );
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("button", { name: "Report" });
    await openVersionHistory();
    fireEvent.click(await screen.findByTestId("canvas-version-1"));
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Board" })).toHaveAttribute(
        "data-editable",
        "false",
      ),
    );
    expect(reviseDiagramLayout).not.toHaveBeenCalled();
  });

  it("keeps Export disabled with an explanation while no destination is admitted", async () => {
    const prepareExport = vi.fn();
    const client = createCanvasClient(readyVersion, undefined, {
      exportOffers: vi.fn(async () => ({
        canvasId: quarterlyCanvasId,
        versionId: quarterlyInventoryEntry.currentVersionId,
        sequence: quarterlyInventoryEntry.currentSequence,
        targets: [],
      })),
      prepareExport,
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More Canvas actions" }));
    const exportItem = await screen.findByRole("menuitem", { name: /Export/ });
    expect(exportItem).toHaveAttribute("aria-disabled", "true");
    expect(exportItem).toHaveTextContent(/No export destination is installed/);
    await user.click(exportItem);
    expect(screen.queryByRole("dialog", { name: "Export canvas" })).toBeNull();
    expect(prepareExport).not.toHaveBeenCalled();
  });

  it("offers no refresh control when the host transport cannot refresh", async () => {
    render(<CanvasWorkspaceTab tab={canvasTab} client={createCanvasClient(readyVersion)} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Refresh canvas/i })).toBeNull();
  });

  it("offers no refresh control when the canvas carries no refreshable source", async () => {
    const refresh = vi.fn();
    const client = createCanvasClient(
      {
        ...readyVersion,
        version: {
          ...readyVersion.version,
          definition: { ...canvasFixture, sourceManifest: [], blocks: [] },
        },
      },
      undefined,
      { refresh } as unknown as Partial<CanvasClient>,
    );

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    await waitFor(() => {
      expect(client.get).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: /Refresh canvas/i })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes the canvas and surfaces the authorized skill provenance", async () => {
    const refresh = vi.fn(async () => ({
      kind: "accepted",
      receipt: {
        schemaVersion: 1,
        kind: "canvas-refresh-receipt",
        requestId: "99999999-9999-4999-8999-999999999999",
        recipeId: "22222222-2222-4222-8222-222222222222",
        canvasId: quarterlyCanvasId,
        outcome: "ready",
        sources: [],
        completedAt: "2026-08-02T09:00:00.000Z",
      },
      contribution: {
        schemaVersion: 1,
        kind: "canvas-skill-contribution",
        qualifiedId: `agents-skills-directory:project:review:${skillDigest}`,
        digest: skillDigest,
        sourceKind: "agents-skills-directory",
        supportedSources: ["attachment"],
        layouts: [],
        presentationRules: [],
      },
    }));
    const client = createCanvasClient(readyVersion, undefined, {
      refresh,
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    await openCanvasTool("Refresh…");
    fireEvent.click(await screen.findByRole("button", { name: /Refresh canvas/i }));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Canvas refreshed.");
    });
    expect(screen.getByTestId("canvas-skill-provenance-source-kind")).toHaveTextContent(
      "agents-skills-directory",
    );
    // An accepted, ready refresh appends a version, so the tab reloads the
    // canvas and its history rather than showing stale content.
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.history).toHaveBeenCalledTimes(2);
  });

  it("reloads the canvas when a cancel loses the race to a completed refresh", async () => {
    const refresh = vi.fn(() => new Promise(() => {}));
    // The authoritative cancel receipt reports the refresh already finished:
    // a new version was saved, so the tab must reload instead of pretending
    // the previous canvas is unchanged.
    const cancelRefresh = vi.fn(async () => ({
      kind: "accepted",
      receipt: {
        schemaVersion: 1,
        kind: "canvas-refresh-receipt",
        requestId: "99999999-9999-4999-8999-999999999999",
        recipeId: "22222222-2222-4222-8222-222222222222",
        canvasId: quarterlyCanvasId,
        outcome: "ready",
        sources: [],
        completedAt: "2026-08-02T09:00:00.000Z",
      },
    }));
    const client = createCanvasClient(readyVersion, undefined, {
      refresh,
      cancelRefresh,
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    await openCanvasTool("Refresh…");
    fireEvent.click(await screen.findByRole("button", { name: /Refresh canvas/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel refresh/i }));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Canvas refreshed.");
    });
    expect(cancelRefresh).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.history).toHaveBeenCalledTimes(2);
  });

  it("refreshes a Work canvas inside the workspace scope the host published", async () => {
    const refresh = vi.fn(async () => ({
      kind: "denied",
      denialCode: "unavailable",
      message: "Host refresh is unavailable.",
    }));
    const client = createCanvasClient(
      {
        ...readyVersion,
        workspace: {
          kind: "work-root",
          projectId: canvasFixture.provenance.projectId,
          rootId: workRootId,
        },
        version: {
          ...readyVersion.version,
          definition: {
            ...canvasFixture,
            provenance: { ...canvasFixture.provenance, mode: "work", threadId: workThreadId },
          },
        },
      } as unknown as Awaited<ReturnType<CanvasClient["get"]>>,
      undefined,
      { refresh } as unknown as Partial<CanvasClient>,
    );

    render(<CanvasWorkspaceTab tab={{ ...canvasTab, mode: "work" }} client={client} />);

    await openCanvasTool("Refresh…");
    fireEvent.click(await screen.findByRole("button", { name: /Refresh canvas/i }));

    // The scope the host published travels back verbatim; a fabricated
    // `chat-virtual` scope is exactly what the server denies as a mismatch.
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    const [request] = refresh.mock.calls[0] as unknown as [
      { readonly workspace: unknown; readonly recipe: { readonly workspace: unknown } },
    ];
    expect(request.workspace).toEqual({
      kind: "work-root",
      projectId: canvasFixture.provenance.projectId,
      rootId: workRootId,
    });
    expect(request.recipe.workspace).toEqual(request.workspace);
  });

  it("withholds mutation surfaces when the host publishes no workspace scope", async () => {
    const refresh = vi.fn();
    const { workspace: _omitted, ...withoutWorkspace } = readyVersion;
    const client = createCanvasClient(withoutWorkspace, undefined, {
      refresh,
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    // The canvas still reads; only the surfaces that would send a scope close.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Refresh canvas/i })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the document full width and opens a block's comments over it from the margin marker", async () => {
    const author = readyVersion.version.createdBy;
    const thread = (commentId: string, blockId: string, body: string, resolved = false) => ({
      comment: {
        commentId: commentId as never,
        anchor: { kind: "block" as const, blockId: blockId as never },
        author,
        origin: { kind: "host" as const },
        body,
        createdAt: "2026-08-01T21:00:00.000Z" as never,
        ...(resolved ? { resolvedAt: "2026-08-01T22:00:00.000Z" as never } : {}),
      },
      replies: [],
    });
    const comments = vi.fn(async () => ({
      kind: "ready" as const,
      canvasId: quarterlyCanvasId,
      sequence: 3,
      threads: [
        thread("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "heading-1", "Rename the overview"),
        thread("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "callout-1", "Cite the source"),
        thread("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "heading-1", "Already fixed", true),
        thread("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "removed-block", "About a deleted block"),
      ],
    }));
    const client = createCanvasClient(readyVersion, undefined, {
      comments,
      comment: vi.fn(),
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    // The count appears only once the drawer has loaded the threads, after the
    // Canvas itself has rendered. Under a loaded parallel run that took longer
    // than the one-second default and the test failed before the comments
    // arrived. The wait stays below this test's own budget so a slow load still
    // ends in this query's diagnostic rather than a bare test timeout, with
    // time left for the clicks that follow.
    const toggle = await screen.findByRole(
      "button",
      { name: "Comments, 3 open" },
      { timeout: 10_000 },
    );
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "1 open comment on Q3 Overview" }));
    expect(screen.getByRole("complementary", { name: "Comments" })).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Rename the overview")).toBeInTheDocument();
    expect(screen.queryByText("Cite the source")).toBeNull();
    expect(screen.queryByText("Already fixed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Cite the source")).toBeInTheDocument();
    expect(screen.getByText("About a deleted block")).toBeInTheDocument();
    expect(screen.getByText("No longer on the canvas")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    expect(screen.getByText("Already fixed")).toBeInTheDocument();
    expect(screen.queryByText("Rename the overview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
  }, 15_000);

  it("moves focus into the comments drawer so Escape closes it and returns to the marker", async () => {
    const comments = vi.fn(async () => ({
      kind: "ready" as const,
      canvasId: quarterlyCanvasId,
      sequence: 3,
      threads: [],
    }));
    const client = createCanvasClient(readyVersion, undefined, {
      comments,
      comment: vi.fn(),
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    const marker = await screen.findByRole("button", { name: "Comment on Q3 Overview" });
    marker.focus();
    fireEvent.click(marker);
    const close = screen.getByRole("button", { name: "Close comments" });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    expect(marker).toHaveFocus();
  });

  it("opens a table row's comments from its marker and returns focus there on Escape", async () => {
    const author = readyVersion.version.createdBy;
    const onRow = (commentId: string, rowId: string, body: string) => ({
      comment: {
        commentId: commentId as never,
        anchor: { kind: "row" as const, blockId: "vendors" as never, rowId: rowId as never },
        author,
        origin: { kind: "host" as const },
        body,
        createdAt: "2026-08-01T21:00:00.000Z" as never,
      },
      replies: [],
    });
    const comments = vi.fn(async () => ({
      kind: "ready" as const,
      canvasId: quarterlyCanvasId,
      sequence: 2,
      threads: [
        onRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1", "globex", "Globex is cheaper"),
        onRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2", "hooli", "Hooli dropped out"),
      ],
    }));
    const withTable = {
      ...readyVersion,
      version: {
        ...readyVersion.version,
        definition: {
          ...canvasFixture,
          blocks: [
            {
              blockId: "vendors",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "table" as const,
              columns: [{ id: "vendor", label: "Vendor", type: "text" as const }],
              rows: [
                { id: "acme", cells: ["Acme"] },
                { id: "globex", cells: ["Globex"] },
              ],
            },
          ],
        },
      },
    };
    const client = createCanvasClient(withTable as never, undefined, {
      comments,
      comment: vi.fn(),
    } as unknown as Partial<CanvasClient>);

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    const marker = await screen.findByRole(
      "button",
      { name: "1 open comment on row Globex" },
      { timeout: 10_000 },
    );
    // The thread on a row that is gone still counts on its table's marker.
    expect(screen.getByRole("button", { name: "2 open comments on table" })).toBeInTheDocument();
    marker.focus();
    fireEvent.click(marker);
    const close = screen.getByRole("button", { name: "Close comments" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(screen.getByText("Globex is cheaper")).toBeInTheDocument();
    expect(screen.queryByText("Hooli dropped out")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Hooli dropped out")).toBeInTheDocument();
    expect(screen.getByText("No longer on the canvas")).toBeInTheDocument();

    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    expect(marker).toHaveFocus();
  }, 15_000);

  it("compares the selected version with the one before it, block by block", async () => {
    const olderVersionId = "45454545-4545-4545-8545-454545454545";
    const blocks = canvasFixture.blocks;
    const olderDefinition = {
      ...canvasFixture,
      title: "Draft Q3 report",
      blocks: [
        { ...blocks[0], text: "Q3 Draft" },
        ...blocks.slice(2),
        { schemaVersion: CANVAS_SCHEMA_VERSION, blockId: "dropped-1", kind: "divider" },
      ],
    } as unknown as typeof canvasFixture;
    const entry = (versionId: string, sequence: number) => ({
      versionId: versionId as never,
      sequence,
      schemaVersion: 1,
      title: quarterlyInventoryEntry.title,
      createdAt: "2026-08-01T21:00:00.000Z" as never,
      createdBy: readyVersion.version.createdBy,
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
      modelId: "octant-test-model" as never,
    });
    const client = createCanvasClient(
      readyVersion,
      {
        kind: "ready",
        history: {
          canvasId: quarterlyCanvasId,
          currentVersionId: quarterlyInventoryEntry.currentVersionId,
          entries: [
            entry(
              quarterlyInventoryEntry.currentVersionId,
              quarterlyInventoryEntry.currentSequence,
            ),
            entry(olderVersionId, 1),
          ],
        },
      } as unknown as Awaited<ReturnType<CanvasClient["history"]>>,
      {
        get: vi.fn(async (_canvasId, versionId) =>
          versionId === olderVersionId
            ? {
                ...readyVersion,
                version: {
                  ...readyVersion.version,
                  versionId: olderVersionId as never,
                  sequence: 1,
                  definition: olderDefinition,
                },
              }
            : readyVersion,
        ),
      },
    );

    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });
    await openVersionHistory();
    fireEvent.click(await screen.findByRole("button", { name: "Compare with v1" }));

    const changes = await screen.findByRole("region", {
      name: `Changes from v1 to v${String(quarterlyInventoryEntry.currentSequence)}`,
    });
    expect(changes).toHaveTextContent("Title changed from “Draft Q3 report”.");
    expect(changes).toHaveTextContent("ChangedQ3 Overview");
    expect(changes).toHaveTextContent("Addedrich text");
    expect(changes).toHaveTextContent("Removeddivider");
  });

  it("refetches export offers after a revision advances the canvas", async () => {
    const exportOffers = vi.fn(async () => ({
      schemaVersion: 1 as const,
      canvasId: quarterlyCanvasId,
      versionId: quarterlyInventoryEntry.currentVersionId,
      targets: [],
    }));
    const revise = vi.fn(async () => ({ kind: "accepted" as const }));
    const client = createCanvasClient(readyVersion, undefined, {
      exportOffers,
      revise,
    } as unknown as Partial<CanvasClient>);
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });
    await waitFor(() => expect(exportOffers).toHaveBeenCalledTimes(1));

    await openCanvasTool("Refine…");
    fireEvent.change(screen.getByRole("textbox", { name: "Revision prompt" }), {
      target: { value: "Tighten the summary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    await waitFor(() => expect(exportOffers).toHaveBeenCalledTimes(2));
  });
  it("resets an open export review when the canvas advances to a new version", async () => {
    const nextVersionId = "99999999-9999-4999-8999-999999999999";
    const offerFor = (versionId: string, sequence: number) => ({
      schemaVersion: 1 as const,
      kind: "canvas-export-offers" as const,
      canvasId: quarterlyCanvasId,
      versionId,
      sequence,
      targets: [
        {
          targetId: "reading-copy",
          label: "Reading copy",
          formats: ["markdown"],
          status: "ready",
        },
      ],
    });
    const exportOffers = vi
      .fn()
      .mockResolvedValueOnce(
        offerFor(quarterlyInventoryEntry.currentVersionId, quarterlyInventoryEntry.currentSequence),
      )
      .mockResolvedValue(offerFor(nextVersionId, quarterlyInventoryEntry.currentSequence + 1));
    let finishRevise: (() => void) | undefined;
    const revise = vi.fn(
      () =>
        new Promise<{ kind: "accepted" }>((resolve) => {
          finishRevise = () => resolve({ kind: "accepted" });
        }),
    );
    const prepareExport = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1,
        kind: "canvas-export-approval",
        approvalId: "44444444-4444-4444-8444-444444444444",
        canvasId: quarterlyCanvasId,
        versionId: quarterlyInventoryEntry.currentVersionId,
        sequence: quarterlyInventoryEntry.currentSequence,
        targetId: "reading-copy",
        destinationLabel: "Reading copy",
        format: "markdown",
        title: "Signed Q3 report",
        payload: "# Signed Q3 report\n",
        payloadDigest: skillDigest,
        byteLength: 20,
        expiresAt: "2026-08-01T21:05:00.000Z",
      },
    }));
    const client = createCanvasClient(readyVersion, undefined, {
      exportOffers,
      prepareExport,
      decideExport: vi.fn(),
      revise,
    } as unknown as Partial<CanvasClient>);
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });
    await waitFor(() => expect(exportOffers).toHaveBeenCalledTimes(1));

    await openCanvasTool("Refine…");
    fireEvent.change(screen.getByRole("textbox", { name: "Revision prompt" }), {
      target: { value: "Tighten the summary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    await waitFor(() => expect(revise).toHaveBeenCalledTimes(1));

    // The revision keeps running after the dialog closes, so it can land while
    // the person is already reviewing an export of the older version.
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Refine canvas" })).toBeNull());
    await openCanvasTool("Export…");
    await user.click(await screen.findByRole("button", { name: "Review export" }));
    expect(await screen.findByText("Export to Reading copy")).toBeInTheDocument();

    await act(async () => {
      finishRevise?.();
    });
    await waitFor(() => expect(exportOffers).toHaveBeenCalledTimes(2));

    expect(await screen.findByRole("button", { name: "Review export" })).toBeInTheDocument();
    expect(screen.queryByText("Export to Reading copy")).toBeNull();
  });

  it("keeps a sticky table header inside the document, under the comments drawer", async () => {
    const client = createCanvasClient(readyVersion, undefined, {
      comments: vi.fn(async () => ({
        kind: "ready" as const,
        canvasId: quarterlyCanvasId,
        sequence: 0,
        threads: [],
      })),
      comment: vi.fn(),
    } as unknown as Partial<CanvasClient>);
    const { container } = render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
    const drawer = screen.getByRole("complementary", { name: "Comments" });
    const header = container.querySelector(".canvas-block__table-grid th");
    const document = container.querySelector(".canvas-workspace-tab__document");
    expect(header).not.toBeNull();
    expect(document).not.toBeNull();

    // A sticky header raises itself above its scrolling rows. It may only do
    // that inside the document's own stacking context; the drawer is outside
    // it and above it, so its Comment button is the topmost thing it covers.
    expect(document?.contains(header ?? null)).toBe(true);
    expect(document?.contains(drawer)).toBe(false);
    expect(cssDeclarations(".canvas-workspace-tab__document")).toMatchObject({
      isolation: "isolate",
      overflow: "auto",
    });
    expect(Number(cssDeclarations(".canvas-workspace-tab__drawer")["z-index"])).toBeGreaterThan(0);
    // The drawer is laid over the body, not over the scrolled document, so
    // scrolling a long Canvas no longer carries the drawer away with it.
    expect(cssDeclarations(".canvas-workspace-tab__body").overflow).not.toBe("auto");
    // In the dock and its narrow sheet the tab is given a bounded height, so
    // it is the document that scrolls under a drawer that stays in view.
    expect(cssDeclarations(".dock-canvas-tool:has(> .canvas-workspace-tab)", dockCss).height).toBe(
      "100%",
    );
    expect(
      cssDeclarations(
        ".octant-dialog__popup:has(> .right-utility-dock__surface .canvas-workspace-tab)",
        dockCss,
      ).height,
    ).toMatch(/^min\(/);
  });

  it("never lets a long unbreakable title widen the tab past its column", () => {
    // jsdom has no layout, so this holds the three rules that measured the
    // 446px Canvas tab in a 411px dock column back to 411px: the dock's grid
    // track and the tab may shrink below their content, and a heading breaks
    // inside a word rather than set that content width.
    expect(cssDeclarations(".dock-canvas-tool", dockCss)["grid-template-columns"]).toBe(
      "minmax(0, 1fr)",
    );
    expect(cssDeclarations(".canvas-workspace-tab")["min-width"]).toBe("0");
    // The same holds inside the tab: the drawer's anchor picker and the
    // version history name blocks and versions by those titles.
    for (const grid of [
      ".canvas-comments",
      ".canvas-comments__compose",
      ".canvas-comments__field",
      ".canvas-workspace-tab__versions",
    ]) {
      expect(cssDeclarations(grid)["grid-template-columns"], grid).toBe("minmax(0, 1fr)");
    }
    expect(cssDeclarations(".canvas-version-history__item")).toMatchObject({
      "white-space": "normal",
      "overflow-wrap": "anywhere",
    });
    for (const heading of [".canvas-view__header h1", ".canvas-block__heading"]) {
      expect(cssDeclarations(heading)["overflow-wrap"], heading).toBe("anywhere");
    }
  });

  it("says why an older version cannot be refined", async () => {
    const olderVersionId = "45454545-4545-4545-8545-454545454545";
    const client = createCanvasClient(readyVersion, twoVersionHistory(olderVersionId), {
      get: vi.fn(async (_canvasId, versionId) =>
        versionId === olderVersionId ? versionOf(olderVersionId, 1) : readyVersion,
      ),
    } as unknown as Partial<CanvasClient>);
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });

    await openVersionHistory();
    fireEvent.click(await screen.findByTestId("canvas-version-1"));
    await screen.findByText("older");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More Canvas actions" }));
    const refine = await screen.findByRole("menuitem", { name: "Refine…" });
    expect(refine).toHaveAttribute("aria-disabled", "true");
    expect(refine).toHaveAccessibleDescription("Older versions can't be refined.");
  });

  it("says why an older version cannot be shared instead of offering a share the host refuses", async () => {
    const olderVersionId = "45454545-4545-4545-8545-454545454545";
    const client = createCanvasClient(readyVersion, twoVersionHistory(olderVersionId), {
      get: vi.fn(async (_canvasId, versionId) =>
        versionId === olderVersionId ? versionOf(olderVersionId, 1) : readyVersion,
      ),
      shareOverview: vi.fn(async () => ({
        schemaVersion: 1,
        kind: "canvas-share-overview",
        canvasId: quarterlyCanvasId,
        hostId: "local",
        projectId: canvasInventoryProjectId,
        sharingEnabled: true,
        owner: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" },
        snapshots: [],
        accessLog: [],
      })),
    } as unknown as Partial<CanvasClient>);
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More Canvas actions" }));
    expect(await screen.findByRole("menuitem", { name: "Share…" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");

    await openVersionHistory();
    fireEvent.click(await screen.findByTestId("canvas-version-1"));
    await screen.findByText("older");

    await user.click(screen.getByRole("button", { name: "More Canvas actions" }));
    const share = await screen.findByRole("menuitem", { name: "Share…" });
    expect(share).toHaveAttribute("aria-disabled", "true");
    expect(share).toHaveAccessibleDescription("Older versions can't be shared.");
  });

  it("holds Share while a picked version is still loading", async () => {
    const olderVersionId = "45454545-4545-4545-8545-454545454545";
    const client = createCanvasClient(readyVersion, twoVersionHistory(olderVersionId), {
      get: vi.fn((_canvasId, versionId) =>
        versionId === olderVersionId ? new Promise(() => undefined) : Promise.resolve(readyVersion),
      ),
      shareOverview: vi.fn(async () => ({
        schemaVersion: 1,
        kind: "canvas-share-overview",
        canvasId: quarterlyCanvasId,
        hostId: "local",
        projectId: canvasInventoryProjectId,
        sharingEnabled: true,
        owner: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" },
        snapshots: [],
        accessLog: [],
      })),
    } as unknown as Partial<CanvasClient>);
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });

    await openVersionHistory();
    fireEvent.click(await screen.findByTestId("canvas-version-1"));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More Canvas actions" }));
    const share = await screen.findByRole("menuitem", { name: "Share…" });
    expect(share).toHaveAttribute("aria-disabled", "true");
    expect(share).toHaveAccessibleDescription("Loading this version…");
  });

  it("shows keyboard focus on a block's comment marker with the hover fill", () => {
    // A marker with open threads is always visible, so revealing it on focus
    // is no cue; without a fill, focus on it could not be seen at all.
    const focus = cssDeclarations(".canvas-block__comment-marker:focus-visible");
    expect(focus.background).toBe(
      cssDeclarations(".canvas-block__comment-marker:hover").background,
    );
    expect(focus.background).toBe("var(--oct-fill-2)");
  });

  it("holds Compare until a version just picked has loaded, then compares that version", async () => {
    type GetOutcome = Awaited<ReturnType<CanvasClient["get"]>>;
    const firstVersionId = "45454545-4545-4545-8545-454545454541";
    const secondVersionId = "45454545-4545-4545-8545-454545454542";
    let finishSecond: ((outcome: GetOutcome) => void) | undefined;
    const tipVersionId = String(quarterlyInventoryEntry.currentVersionId);
    const tip = versionOf(tipVersionId, 3);
    const second = versionOf(secondVersionId, 2, { ...canvasFixture, title: "Second draft" });
    const get = vi.fn((_canvasId: unknown, versionId?: string) => {
      if (versionId === secondVersionId && finishSecond === undefined) {
        return new Promise<GetOutcome>((resolve) => {
          finishSecond = resolve;
        });
      }
      if (versionId === secondVersionId) return Promise.resolve(second);
      if (versionId === firstVersionId) {
        return Promise.resolve(
          versionOf(firstVersionId, 1, { ...canvasFixture, title: "First draft" }),
        );
      }
      return Promise.resolve(tip);
    });
    const client = createCanvasClient(
      tip,
      historyOf([
        [firstVersionId, 1],
        [secondVersionId, 2],
        [tipVersionId, 3],
      ]),
      { get } as unknown as Partial<CanvasClient>,
    );
    render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
    await screen.findByRole("heading", { name: "Signed Q3 report" });

    await openVersionHistory();
    fireEvent.click(await screen.findByTestId("canvas-version-2"));
    // Reopened at once, the popover still describes the head, whose
    // neighbour is v2; comparing now would pair v2 with the v2 arriving.
    await openVersionHistory();
    expect(await screen.findByRole("button", { name: "Compare with v2" })).toBeDisabled();

    // The popover stays open and catches up with the version that arrived.
    await act(async () => {
      finishSecond?.(second);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Compare with v1" }));
    const changes = await screen.findByRole("region", { name: "Changes from v1 to v2" });
    expect(changes).toHaveTextContent("Title changed from “First draft”.");
  });

  it("releases Compare when a version it was waiting for fails to load", async () => {
    const olderVersionId = "45454545-4545-4545-8545-454545454545";
    const get = vi.fn(async (_canvasId: unknown, versionId?: string) => {
      if (versionId === olderVersionId) throw new Error("network down");
      return readyVersion;
    });
    const client = createCanvasClient(readyVersion, twoVersionHistory(olderVersionId), {
      get,
    } as unknown as Partial<CanvasClient>);
    const unhandled = (event: PromiseRejectionEvent) => event.preventDefault();
    window.addEventListener("unhandledrejection", unhandled);
    const swallow = (reason: unknown) => {
      if (!(reason instanceof Error && reason.message === "network down")) throw reason;
    };
    process.on("unhandledRejection", swallow);
    try {
      render(<CanvasWorkspaceTab tab={canvasTab} client={client} />);
      await screen.findByRole("heading", { name: "Signed Q3 report" });
      await openVersionHistory();
      fireEvent.click(await screen.findByTestId("canvas-version-1"));
      await waitFor(() => expect(get).toHaveBeenCalledWith(quarterlyCanvasId, olderVersionId));
      await openVersionHistory();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Compare with v1" })).toBeEnabled(),
      );
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
      process.off("unhandledRejection", swallow);
    }
  });
});

describe("CanvasWorkspaceTab in the narrow dock sheet", () => {
  const canvasSurface = dockCanvasSurface();

  function renderInSheet(client: CanvasClient, onClose = vi.fn()) {
    render(
      <RightUtilityDock
        canvas={<CanvasWorkspaceTab tab={canvasTab} client={client} />}
        isNarrow
        launchableSurfaces={[canvasSurface]}
        onClose={onClose}
        onCloseTab={vi.fn()}
        onCommitWidth={vi.fn()}
        onOpenTab={vi.fn()}
        onPreviewWidth={vi.fn()}
        onSelectSurface={vi.fn()}
        open
        resolution={{ kind: "surface", surface: canvasSurface }}
        tabs={[canvasSurface]}
        width={360}
      />,
    );
    return onClose;
  }

  /** The stacking order the root context gives a fixed or positioned box. */
  function rootLayer(element: Element): { readonly node: Element; readonly z: number } {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const tailwind = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(node.getAttribute("class") ?? "");
      if (tailwind !== null) return { node, z: Number(tailwind[1]) };
      const declared = (node.getAttribute("class") ?? "")
        .split(/\s+/)
        .map((name) => cssDeclarations(`.${name}`, dockCss, false)["z-index"])
        .find((value) => value !== undefined);
      if (declared !== undefined) return { node, z: Number(declared) };
    }
    throw new Error("No stacking layer above the element.");
  }

  function paintsAbove(upper: Element, lower: Element): boolean {
    const top = rootLayer(upper);
    const bottom = rootLayer(lower);
    if (top.z !== bottom.z) return top.z > bottom.z;
    // Equal layers paint in document order.
    return Boolean(
      bottom.node.compareDocumentPosition(top.node) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }

  it("raises the version history and the More menu above the sheet", async () => {
    renderInSheet(createCanvasClient(readyVersion, twoVersionHistory()));
    const sheet = await screen.findByRole("dialog", { name: canvasSurface.label });
    await screen.findByRole("heading", { name: "Signed Q3 report" });

    await openVersionHistory();
    const history = await screen.findByRole("dialog", { name: "Version history" });
    expect(paintsAbove(history, sheet)).toBe(true);
    fireEvent.keyDown(history, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Version history" })).toBeNull(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More Canvas actions" }));
    const menu = await screen.findByRole("menu");
    expect(paintsAbove(menu, sheet)).toBe(true);
  });

  it("closes the comments drawer on the first Escape and the sheet on the next", async () => {
    const client = createCanvasClient(readyVersion, undefined, {
      comments: vi.fn(async () => ({
        kind: "ready" as const,
        canvasId: quarterlyCanvasId,
        sequence: 0,
        threads: [],
      })),
      comment: vi.fn(),
    } as unknown as Partial<CanvasClient>);
    const onClose = renderInSheet(client);
    await screen.findByRole("heading", { name: "Signed Q3 report" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comments" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close comments" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: canvasSurface.label })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const canvasCss = readFileSync(join(webRoot, "styles/canvas.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const dockCss = readFileSync(join(webRoot, "styles/dock.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of every top-level rule naming `selector`, later rules winning. */
function cssDeclarations(
  selector: string,
  css = canvasCss,
  required = true,
): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = {};
  let found = false;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? "").split(",").map((value) => value.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    found = true;
    for (const declaration of (rule[2] ?? "").split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  if (required) expect(found, `missing CSS rule for ${selector}`).toBe(true);
  return declarations;
}

function dockCanvasSurface(): (typeof RIGHT_UTILITY_DOCK_SURFACES)[number] {
  const surface = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === "canvas");
  if (surface === undefined) throw new Error("Missing canvas dock surface.");
  return surface;
}

function versionOf(
  versionId: string,
  sequence: number,
  definition: typeof canvasFixture = canvasFixture,
): Awaited<ReturnType<CanvasClient["get"]>> {
  return {
    ...readyVersion,
    version: { ...readyVersion.version, versionId: versionId as never, sequence, definition },
  } as Awaited<ReturnType<CanvasClient["get"]>>;
}

function historyOf(
  entries: ReadonlyArray<readonly [string, number]>,
): Awaited<ReturnType<CanvasClient["history"]>> {
  return {
    kind: "ready",
    history: {
      canvasId: quarterlyCanvasId,
      currentVersionId: quarterlyInventoryEntry.currentVersionId,
      entries: entries.map(([versionId, sequence]) => ({
        versionId: versionId as never,
        sequence,
        schemaVersion: 1,
        title: quarterlyInventoryEntry.title,
        createdAt: "2026-08-01T21:00:00.000Z" as never,
        createdBy: readyVersion.version.createdBy,
        providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
        modelId: "octant-test-model" as never,
      })),
    },
  } as unknown as Awaited<ReturnType<CanvasClient["history"]>>;
}

function twoVersionHistory(
  olderVersionId = "45454545-4545-4545-8545-454545454545",
): Awaited<ReturnType<CanvasClient["history"]>> {
  return historyOf([
    [olderVersionId, 1],
    [String(quarterlyInventoryEntry.currentVersionId), quarterlyInventoryEntry.currentSequence],
  ]);
}
