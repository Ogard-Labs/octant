import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { CanvasShareOverview } from "@octant/contracts/canvas-share-access-log";
import type {
  CanvasShareResult,
  CanvasShareSnapshotRequest,
} from "@octant/contracts/canvas-share-snapshot";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
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
  readonly onOpen?: () => Promise<never>;
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
