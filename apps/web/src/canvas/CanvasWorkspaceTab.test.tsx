import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import { decodeTabGroupId } from "@octant/contracts/shell";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  canvasInventoryProjectId,
  quarterlyCanvasId,
  quarterlyInventoryEntry,
} from "../projects/canvasInventoryFixtures";
import { CanvasWorkspaceTab } from "./CanvasWorkspaceTab";
import { canvasFixture } from "./test-fixtures";

const groupId = decodeTabGroupId("66666666-6666-4666-8666-666666666666");
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

describe("CanvasWorkspaceTab", () => {
  it("renders the authorized canvas definition when get returns ready", async () => {
    render(
      <CanvasWorkspaceTab
        groupId={groupId}
        tab={canvasTab}
        client={createCanvasClient(readyVersion)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Canvas unavailable")).not.toBeInTheDocument();
  });

  it("shows an unavailable placeholder when the projection row is missing", async () => {
    render(
      <CanvasWorkspaceTab
        groupId={groupId}
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
    render(<CanvasWorkspaceTab groupId={groupId} tab={canvasTab} client={undefined} />);
    expect(screen.getByText("The host canvas client is unavailable.")).toBeInTheDocument();
  });

  it("exposes pin and attach-context actions when handlers are provided", async () => {
    const onTogglePin = vi.fn();
    const onAttachContext = vi.fn();

    render(
      <CanvasWorkspaceTab
        groupId={groupId}
        tab={canvasTab}
        client={createCanvasClient(readyVersion)}
        onAttachContext={onAttachContext}
        onTogglePin={onTogglePin}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Pin Quarterly summary/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Pin Quarterly summary/i }));
    expect(onTogglePin).toHaveBeenCalledWith(groupId, canvasTab);

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
        groupId={groupId}
        tab={canvasTab}
        client={createCanvasClient(readyVersion, historyOutcome, {
          get,
        } as unknown as Partial<CanvasClient>)}
        onAttachContext={onAttachContext}
        onTogglePin={vi.fn()}
      />,
    );

    // Two quick selections: first the older version, then back to the tip.
    fireEvent.click(await screen.findByTestId("canvas-version-1"));
    fireEvent.click(
      screen.getByTestId(`canvas-version-${quarterlyInventoryEntry.currentSequence}`),
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

  it("offers no refresh control when the host transport cannot refresh", async () => {
    render(
      <CanvasWorkspaceTab
        groupId={groupId}
        tab={canvasTab}
        client={createCanvasClient(readyVersion)}
      />,
    );

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

    render(<CanvasWorkspaceTab groupId={groupId} tab={canvasTab} client={client} />);

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

    render(<CanvasWorkspaceTab groupId={groupId} tab={canvasTab} client={client} />);

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

    render(<CanvasWorkspaceTab groupId={groupId} tab={canvasTab} client={client} />);

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

    render(
      <CanvasWorkspaceTab groupId={groupId} tab={{ ...canvasTab, mode: "work" }} client={client} />,
    );

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

    render(<CanvasWorkspaceTab groupId={groupId} tab={canvasTab} client={client} />);

    // The canvas still reads; only the surfaces that would send a scope close.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Refresh canvas/i })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows pinned state when the tab carries presentation pin", async () => {
    render(
      <CanvasWorkspaceTab
        groupId={groupId}
        tab={{ ...canvasTab, pinned: true }}
        client={createCanvasClient(readyVersion)}
        onAttachContext={vi.fn()}
        onTogglePin={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Unpin Quarterly summary/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });
});
