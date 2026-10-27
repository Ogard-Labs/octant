import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { CanvasShareOverview } from "@octant/contracts/canvas-share-access-log";
import type {
  CanvasShareResult,
  CanvasShareSnapshotRequest,
} from "@octant/contracts/canvas-share-snapshot";
import { commitsByHourExample, hottestFilesExample, repositoryMapExample } from "@octant/domain";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { HostPlatformContext } from "../platform";
import { CanvasSharePanel } from "./CanvasSharePanel";

const canvasId = "11111111-1111-4111-8111-111111111111" as CanvasId;
const versionId = "22222222-2222-4222-8222-222222222222" as CanvasVersionId;
const ownerId = "99999999-9999-4999-8999-999999999999";
const snapshotId = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const now = new Date("2026-08-01T21:00:00.000Z");

function overview(overrides: Record<string, unknown> = {}): CanvasShareOverview {
  return {
    schemaVersion: 1,
    kind: "canvas-share-overview",
    canvasId,
    hostId: "local",
    projectId: "66666666-6666-4666-8666-666666666666",
    sharingEnabled: true,
    owner: { kind: "local-user", actorId: ownerId },
    snapshots: [],
    accessLog: [],
    ...overrides,
  } as unknown as CanvasShareOverview;
}

function activeSnapshot(status: "active" | "revoked" = "active") {
  return {
    schemaVersion: 1,
    kind: "canvas-share-snapshot-summary",
    snapshotId,
    canvasId,
    versionId,
    sequence: 1,
    hostId: "local",
    projectId: "66666666-6666-4666-8666-666666666666",
    audience: {
      ownerActorId: ownerId,
      principals: [{ label: "This device", principalKind: "local-user", principalId: ownerId }],
    },
    createdAt: "2026-08-01T21:00:00.000Z",
    expiresAt: "2026-08-02T21:00:00.000Z",
    refreshPolicy: "manual-only",
    status,
    ...(status === "revoked" ? { revokedAt: "2026-08-01T22:00:00.000Z" } : {}),
  };
}

function exportDocument() {
  return {
    schemaVersion: 1,
    kind: "canvas-static-export-document",
    exportId: "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e",
    canvasId,
    versionId,
    sequence: 1,
    exportedAt: "2026-08-01T21:05:00.000Z",
    title: "Quarterly summary snapshot",
    channel: "authenticated-snapshot",
    sharingEnabled: true,
    provenance: {
      hostId: "local",
      projectId: "66666666-6666-4666-8666-666666666666",
      mode: "chat",
      threadId: "13131313-1313-4313-8313-131313131313",
      createdAt: "2026-08-01T20:00:00.000Z",
      providerLabel: "Test Provider",
      modelLabel: "octant-test-model",
      actorKind: "local-user",
    },
    sourceManifest: [],
    blocks: [
      {
        blockId: "block-1",
        schemaVersion: 1,
        kind: "heading",
        level: 2,
        text: "Signed Q3 numbers",
      },
      { blockId: "block-2", schemaVersion: 1, kind: "rich-text", text: "Revenue grew steadily." },
    ],
    threatModelId: "canvas-share-authenticated-snapshot-v1",
  };
}

function renderPanel(props: {
  readonly overview: CanvasShareOverview;
  readonly onShare?: (request: CanvasShareSnapshotRequest) => Promise<CanvasShareResult>;
  readonly onRevoke?: () => Promise<CanvasShareResult>;
  readonly onOpen?: (request: { readonly runDesign?: unknown }) => Promise<never>;
  readonly holdsDesign?: boolean;
  readonly resolveDesignPage?: (path: string) => string;
}) {
  const accepted: CanvasShareResult = {
    kind: "denied",
    denialCode: "unavailable",
    message: "unused",
  } as CanvasShareResult;
  return render(
    <CanvasSharePanel
      canvasId={canvasId}
      expectedSequence={1}
      newId={() => "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c"}
      now={() => now}
      onOpen={props.onOpen ?? (async () => accepted as never)}
      onRevoke={props.onRevoke ?? (async () => accepted)}
      onShare={props.onShare ?? (async () => accepted)}
      overview={props.overview}
      versionId={versionId}
      {...(props.holdsDesign === undefined ? {} : { holdsDesign: props.holdsDesign })}
      {...(props.resolveDesignPage === undefined
        ? {}
        : { resolveDesignPage: props.resolveDesignPage })}
    />,
  );
}

describe("CanvasSharePanel", () => {
  it("shares only after explicit dual consent, with the host-published owner as audience", async () => {
    const user = userEvent.setup();
    const onShare = vi.fn(
      async (_request: CanvasShareSnapshotRequest): Promise<CanvasShareResult> =>
        ({ kind: "accepted", snapshot: activeSnapshot() }) as unknown as CanvasShareResult,
    );
    renderPanel({ overview: overview(), onShare });

    fireEvent.click(screen.getByTestId("canvas-share-submit"));
    expect(onShare).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("canvas-share-consent-snapshot"));
    fireEvent.click(screen.getByTestId("canvas-share-consent-audience"));
    await chooseSelectFieldOption(user, screen.getByTestId("canvas-share-expiry"), "1 hour");
    fireEvent.click(screen.getByTestId("canvas-share-submit"));

    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1));
    const request = onShare.mock.calls[0]![0] as unknown as CanvasShareSnapshotRequest;
    expect(request.consent.acknowledgedAuthenticatedSnapshot).toBe(true);
    expect(request.consent.acknowledgedOwnerVisibleAudience).toBe(true);
    // The renderer never invents an identity: owner, host, and Project are the
    // host's own published values.
    expect(String(request.audience.ownerActorId)).toBe(ownerId);
    expect(request.hostId).toBe("local");
    expect(request.expiresAt).toBe("2026-08-01T22:00:00.000Z");
    expect(await screen.findByTestId("canvas-share-status")).toHaveTextContent("Snapshot shared.");
  });

  it("asks for a third acknowledgement before sharing a Canvas that holds a design, and sends it", async () => {
    const onShare = vi.fn(
      async (_request: CanvasShareSnapshotRequest): Promise<CanvasShareResult> =>
        ({ kind: "accepted", snapshot: activeSnapshot() }) as unknown as CanvasShareResult,
    );
    renderPanel({ overview: overview(), onShare, holdsDesign: true });

    fireEvent.click(screen.getByTestId("canvas-share-consent-snapshot"));
    fireEvent.click(screen.getByTestId("canvas-share-consent-audience"));
    fireEvent.click(screen.getByTestId("canvas-share-submit"));
    // The two ordinary ticks are not enough: markup leaves as written.
    expect(onShare).not.toHaveBeenCalled();

    const markup = screen.getByTestId("canvas-share-consent-markup");
    expect(markup.closest("label")).toHaveTextContent("shared exactly as written");
    fireEvent.click(markup);
    fireEvent.click(screen.getByTestId("canvas-share-submit"));

    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1));
    expect(onShare.mock.calls[0]?.[0].consent).toMatchObject({
      acknowledgedMarkupSharedAsWritten: true,
    });
  });

  it("asks for no markup acknowledgement when the Canvas holds no design", async () => {
    const onShare = vi.fn(
      async (_request: CanvasShareSnapshotRequest): Promise<CanvasShareResult> =>
        ({ kind: "accepted", snapshot: activeSnapshot() }) as unknown as CanvasShareResult,
    );
    renderPanel({ overview: overview(), onShare });

    expect(screen.queryByTestId("canvas-share-consent-markup")).toBeNull();
    fireEvent.click(screen.getByTestId("canvas-share-consent-snapshot"));
    fireEvent.click(screen.getByTestId("canvas-share-consent-audience"));
    fireEvent.click(screen.getByTestId("canvas-share-submit"));
    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1));
    expect(onShare.mock.calls[0]?.[0].consent).not.toHaveProperty(
      "acknowledgedMarkupSharedAsWritten",
    );
  });

  it("draws a shared design under the frame policy and runs a shared prototype from a page ticketed for the snapshot", async () => {
    const page = `/api/canvas/design-page?ticket=${"a".repeat(43)}`;
    const shared = {
      ...exportDocument(),
      schemaVersion: 10,
      blocks: [
        {
          blockId: "spec",
          schemaVersion: 16,
          kind: "design",
          title: "Spec",
          size: "document",
          frames: [{ frameId: "spec", title: "Spec", html: "<article><h1>Ranking</h1></article>" }],
        },
        {
          blockId: "cart",
          schemaVersion: 18,
          kind: "design",
          title: "Cart",
          size: "phone",
          runsScript: true,
          frames: [
            { frameId: "cart", title: "Cart", html: '<button onclick="add()">Add</button>' },
          ],
        },
      ],
    };
    const onOpen = vi.fn(
      async (request: { readonly runDesign?: unknown }) =>
        ({
          kind: "allowed",
          document: shared,
          event: { eventId: "x" },
          ...(request.runDesign === undefined ? {} : { designPage: page }),
        }) as never,
    );
    renderPanel({
      overview: overview({ snapshots: [activeSnapshot()] }),
      onOpen,
      resolveDesignPage: (path) => `http://127.0.0.1:13773${path}`,
    });

    fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));
    const view = await screen.findByTestId("canvas-share-snapshot-view");

    // The static frame is the same srcdoc frame the live Canvas draws: no
    // script, and nothing it can load.
    const still = within(view).getByTitle<HTMLIFrameElement>("Spec, document");
    expect(still.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(still.srcdoc).toContain("default-src 'none'");

    // The prototype waits for the person, then runs from the ticketed page.
    expect(within(view).queryByTitle("Cart, running prototype")).toBeNull();
    fireEvent.click(within(view).getByRole("button", { name: "Run" }));
    const running = await within(view).findByTitle<HTMLIFrameElement>("Cart, running prototype");
    expect(running.getAttribute("sandbox")).toBe("allow-scripts");
    expect(running.getAttribute("src")).toBe(`http://127.0.0.1:13773${page}`);
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "canvas-share-access",
        snapshotId,
        runDesign: { blockId: "cart" },
      }),
    );
  });

  describe("on the desktop", () => {
    const cartSnapshot = () => {
      const page = `/api/canvas/design-page?ticket=${"a".repeat(43)}`;
      const shared = {
        ...exportDocument(),
        schemaVersion: 10,
        blocks: [
          {
            blockId: "cart",
            schemaVersion: 18,
            kind: "design",
            title: "Cart",
            size: "phone",
            runsScript: true,
            frames: [{ frameId: "cart", title: "Cart", html: "<button>Add</button>" }],
          },
        ],
      };
      const onOpen = vi.fn(
        async (request: { readonly runDesign?: unknown }) =>
          ({
            kind: "allowed",
            document: shared,
            event: { eventId: "x" },
            ...(request.runDesign === undefined ? {} : { designPage: page }),
          }) as never,
      );
      return { page, shared, onOpen };
    };

    afterEach(() => {
      delete (window as { octantHost?: unknown }).octantHost;
    });

    // The renderer recognises the desktop bridge by its credential methods.
    const desktopBridge = (fields: Record<string, unknown>) => {
      (window as { octantHost?: unknown }).octantHost = {
        setProviderCredential: () => undefined,
        providerCredentialStatus: () => undefined,
        clearProviderCredential: () => undefined,
        listProviderApiKeys: () => undefined,
        addProviderApiKey: () => undefined,
        renameProviderApiKey: () => undefined,
        replaceProviderApiKey: () => undefined,
        removeProviderApiKey: () => undefined,
        setActiveProviderApiKey: () => undefined,
        moveProviderApiKey: () => undefined,
        ...fields,
      };
    };

    it("prepares the prototype surface before it takes a ticket, and draws the snapshot's prototype on it", async () => {
      const order: Array<string> = [];
      const opened: Array<string> = [];
      desktopBridge({
        prepareCanvasPrototypeSurface: async () => {
          order.push("surface");
          return { status: "ready" };
        },
        openCanvasPrototype: async (request: { readonly src: string }) => {
          opened.push(request.src);
          return { status: "open" };
        },
        subscribeCanvasPrototypeEvents: () => () => undefined,
      });
      const { page, shared, onOpen } = cartSnapshot();
      onOpen.mockImplementation(async (request) => {
        if (request.runDesign !== undefined) order.push("ticket");
        return {
          kind: "allowed",
          document: shared,
          event: { eventId: "x" },
          ...(request.runDesign === undefined ? {} : { designPage: page }),
        } as never;
      });
      renderPanel({
        overview: overview({ snapshots: [activeSnapshot()] }),
        onOpen,
        resolveDesignPage: (path) => `http://127.0.0.1:3773${path}`,
      });
      fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));
      const view = await screen.findByTestId("canvas-share-snapshot-view");
      fireEvent.click(within(view).getByRole("button", { name: "Run" }));
      const running = await within(view).findByTitle("Cart, running prototype");
      expect(running.tagName).toBe("CANVAS");
      // The address is the one the main process accepts: this host's origin,
      // the design-page path, and one 43-character ticket.
      expect(opened).toEqual([`http://127.0.0.1:3773${page}`]);
      expect(order).toEqual(["surface", "ticket"]);
    });

    it("says why a snapshot's prototype does not run when the surface is unavailable, and takes no ticket", async () => {
      desktopBridge({
        prepareCanvasPrototypeSurface: async () => ({
          status: "unavailable",
          reason: "Octant could not close the prototype surface's network, so it does not run.",
        }),
      });
      const { onOpen } = cartSnapshot();
      renderPanel({
        overview: overview({ snapshots: [activeSnapshot()] }),
        onOpen,
        resolveDesignPage: (path) => `http://127.0.0.1:3773${path}`,
      });
      fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));
      const view = await screen.findByTestId("canvas-share-snapshot-view");
      fireEvent.click(within(view).getByRole("button", { name: "Run" }));
      expect(await within(view).findByText(/could not close the prototype surface/)).toBeVisible();
      expect(within(view).queryByTitle("Cart, running prototype")).toBeNull();
      expect(onOpen.mock.calls.filter(([request]) => request.runDesign !== undefined)).toHaveLength(
        0,
      );
    });
  });

  it("says plainly when the host does not share and offers no control", () => {
    renderPanel({ overview: overview({ sharingEnabled: false }) });

    expect(screen.getByTestId("canvas-share-disabled")).toHaveTextContent(
      "Sharing is turned off on this host.",
    );
    expect(screen.queryByTestId("canvas-share-submit")).toBeNull();
  });

  it("revokes a listed share and reports a refused open in safe copy", async () => {
    const onRevoke = vi.fn(
      async (): Promise<CanvasShareResult> =>
        ({ kind: "accepted", snapshot: activeSnapshot("revoked") }) as unknown as CanvasShareResult,
    );
    const onOpen = vi.fn(
      async () =>
        ({
          kind: "denied",
          outcome: "denied-revoked",
          event: { eventId: "x" },
        }) as never,
    );
    renderPanel({
      overview: overview({ snapshots: [activeSnapshot()] }),
      onRevoke,
      onOpen,
    });

    fireEvent.click(screen.getByTestId(`canvas-share-revoke-${snapshotId}`));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("canvas-share-status")).toHaveTextContent(
      "Share revoked. It can no longer be opened.",
    );

    fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("canvas-share-status")).toHaveTextContent(
      "That share was revoked.",
    );
    // A refused open must never surface the shared document.
    expect(screen.queryByTestId("canvas-share-snapshot-view")).toBeNull();
  });

  it("renders the sanitized snapshot document when an open is allowed", async () => {
    const onOpen = vi.fn(
      async () =>
        ({
          kind: "allowed",
          document: exportDocument(),
          event: { eventId: "x" },
        }) as never,
    );
    renderPanel({ overview: overview({ snapshots: [activeSnapshot()] }), onOpen });

    fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));

    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("canvas-share-status")).toHaveTextContent("Snapshot opened.");
    const view = await screen.findByTestId("canvas-share-snapshot-view");
    // The user sees the shared copy itself — title and content — clearly
    // labeled as the snapshot, never just a claim that it was opened.
    expect(view).toHaveTextContent("Quarterly summary snapshot");
    expect(view).toHaveTextContent("Signed Q3 numbers");
    expect(view).toHaveTextContent("Revenue grew steadily.");
    expect(view).toHaveTextContent("not the live canvas");

    fireEvent.click(screen.getByTestId("canvas-share-snapshot-close"));
    expect(screen.queryByTestId("canvas-share-snapshot-view")).toBeNull();
  });

  it("draws a shared treemap, heatmap, and bar list in the opened snapshot", async () => {
    const onOpen = vi.fn(
      async () =>
        ({
          kind: "allowed",
          document: {
            ...exportDocument(),
            schemaVersion: 3,
            blocks: [repositoryMapExample, commitsByHourExample, hottestFilesExample],
          },
          event: { eventId: "x" },
        }) as never,
    );
    renderPanel({ overview: overview({ snapshots: [activeSnapshot()] }), onOpen });

    fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));

    const view = await screen.findByTestId("canvas-share-snapshot-view");
    for (const kind of ["treemap", "heatmap", "bar-list"]) {
      expect(view.querySelector(`[data-block-kind="${kind}"]`)).not.toBeNull();
    }
    expect(view).toHaveTextContent("Lines of code");
    expect(view).toHaveTextContent("Commits");
    expect(view).toHaveTextContent("packages/domain/src/canvasPolicy.ts");
  });

  it("fails closed when an allowed open serves a document that is not the sanitized contract", async () => {
    const onOpen = vi.fn(
      async () =>
        ({
          kind: "allowed",
          document: {
            ...exportDocument(),
            blocks: [{ blockId: "block-1", schemaVersion: 1, kind: "hostile-embed" }],
          },
          event: { eventId: "x" },
        }) as never,
    );
    renderPanel({ overview: overview({ snapshots: [activeSnapshot()] }), onOpen });

    fireEvent.click(screen.getByTestId(`canvas-share-open-${snapshotId}`));

    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("canvas-share-status")).toHaveTextContent(
      "The snapshot could not be opened.",
    );
    expect(screen.queryByTestId("canvas-share-snapshot-view")).toBeNull();
  });

  it("shows the honest access log the host published", () => {
    renderPanel({
      overview: overview({
        snapshots: [activeSnapshot("revoked")],
        accessLog: [
          {
            schemaVersion: 1,
            kind: "canvas-share-access-log",
            eventId: "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d",
            snapshotId,
            canvasId,
            hostId: "local",
            projectId: "66666666-6666-4666-8666-666666666666",
            occurredAt: "2026-08-01T21:30:00.000Z",
            outcome: "denied-revoked",
            browserFamily: "safari",
          },
        ],
      }),
    });

    expect(screen.getByTestId("canvas-share-access-log")).toHaveTextContent(
      "That share was revoked.",
    );
    // A revoked row offers no revoke control to press again.
    expect(screen.queryByTestId(`canvas-share-revoke-${snapshotId}`)).toBeNull();
  });
});

// Each host is seen from a window on the other platform, so copy that read the
// window's platform instead of the host's would name the wrong computer.
const HOSTS = [
  { hostPlatform: "linux", window: "MacIntel", computer: "this computer", elsewhere: /this Mac/ },
  {
    hostPlatform: "darwin",
    window: "Linux x86_64",
    computer: "this Mac",
    elsewhere: /this computer/,
  },
] as const;

describe.each(HOSTS)("CanvasSharePanel on a $hostPlatform host", (host) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: host.window, configurable: true });
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));

  it("says a share stays on the host's computer", () => {
    render(
      <HostPlatformContext.Provider value={host.hostPlatform}>
        <CanvasSharePanel
          canvasId={canvasId}
          expectedSequence={1}
          newId={() => "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c"}
          now={() => now}
          onOpen={async () => {
            throw new Error("unused");
          }}
          onRevoke={async () => {
            throw new Error("unused");
          }}
          onShare={async () => {
            throw new Error("unused");
          }}
          overview={overview({ sharingEnabled: false })}
          versionId={versionId}
        />
      </HostPlatformContext.Provider>,
    );

    const description = screen.getByText(/^A share is a read-only snapshot/);
    expect(description).toHaveTextContent(
      `It stays on ${host.computer} — nothing is uploaded, and there is no link.`,
    );
    expect(description.textContent).not.toMatch(host.elsewhere);
  });
});
