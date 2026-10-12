import type {
  CanvasBlock,
  CanvasId,
  CanvasLayoutGroupBlock,
  CanvasVersionId,
} from "@octant/contracts/canvas";
import {
  decodeCanvasStaticExportDocument,
  type CanvasStaticExportDocument,
} from "@octant/contracts/canvas-share";
import {
  decodeCanvasShareAccessRequest,
  type CanvasShareAccessOutcome,
  type CanvasShareAccessRequest,
  type CanvasShareAccessResult,
  type CanvasShareOverview,
} from "@octant/contracts/canvas-share-access-log";
import type {
  CanvasShareDenialCode,
  CanvasShareResult,
  CanvasShareSnapshotId,
  CanvasShareSnapshotRequest,
  CanvasShareSnapshotRevokeRequest,
  CanvasShareSnapshotSummary,
} from "@octant/contracts/canvas-share-snapshot";
import { Ban, Check, Eye, Share2, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  canvasReadingOrder,
  type CanvasPlacedReadingItem,
} from "@octant/domain/canvas-dashboard-layout";
import { CanvasBlockRenderer } from "./blocks/CanvasBlock";
import { runsInDesktopApp, type DesignRunRuntime } from "./blocks/designRunningFrame";
import { CanvasLayoutGroup } from "./blocks/LayoutGroups";
import { DashboardBlock } from "./blocks/DashboardBlock";

/**
 * Canvas sharing.
 *
 * A share is a sanitized snapshot of one canvas version, kept on this host and
 * readable only by a principal the host can authenticate. The renderer asserts
 * nothing: the owner identity, host, and Project all come from the host's own
 * overview and are re-checked server-side before a snapshot exists or is served,
 * so holding them here widens nothing. Consent is collected explicitly because
 * the policy requires it, and every state is conveyed with an icon *and* words.
 */

const EXPIRY_CHOICES = [
  { id: "1h", label: "1 hour", ms: 60 * 60 * 1_000 },
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1_000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1_000 },
] as const;

const DENIAL_COPY: Record<CanvasShareDenialCode, string> = {
  "malformed-request": "This share request was not valid.",
  "sharing-disabled": "Sharing is turned off on this host.",
  "consent-required": "Sharing needs every acknowledgement from you.",
  "scope-mismatch": "This canvas belongs to a different workspace.",
  "stale-version": "This canvas changed. Reopen it and share again.",
  "unsafe-payload": "This canvas cannot be shared safely.",
  "unsupported-channel": "This kind of share is not available here.",
  expired: "That share has expired.",
  revoked: "That share was already revoked.",
  "audience-required": "A share needs someone who can open it.",
  unauthorized: "Sharing this canvas is not authorized here.",
  "public-audience-forbidden": "Public shares are not available.",
  unavailable: "Sharing is unavailable for this canvas right now.",
};

const ACCESS_COPY: Record<CanvasShareAccessOutcome, string> = {
  allowed: "Snapshot opened.",
  "denied-expired": "That share has expired.",
  "denied-revoked": "That share was revoked.",
  "denied-audience": "This share is not addressed to you.",
  "denied-deleted-source": "The canvas behind this share is gone.",
  "denied-scope-mismatch": "That request did not match this share.",
  "denied-sharing-disabled": "Sharing is turned off on this host.",
};

/** Safe, metadata-free copy for a share denial; never the server message. */
export function safeCanvasShareDenialReason(code: CanvasShareDenialCode): string {
  return DENIAL_COPY[code];
}

type ShareRun =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

export interface CanvasSharePanelProps {
  readonly canvasId: CanvasId;
  readonly versionId: CanvasVersionId;
  readonly expectedSequence: number;
  /** Everything the host published about sharing this canvas. */
  readonly overview: CanvasShareOverview;
  readonly onShare: (request: CanvasShareSnapshotRequest) => Promise<CanvasShareResult>;
  readonly onRevoke: (request: CanvasShareSnapshotRevokeRequest) => Promise<CanvasShareResult>;
  readonly onOpen: (request: CanvasShareAccessRequest) => Promise<CanvasShareAccessResult>;
  /**
   * Whether the version being shared holds a design. A design is markup, which
   * leaves as written, so sharing one asks for a third acknowledgement.
   */
  readonly holdsDesign?: boolean;
  /**
   * The address of a prototype page the host ticketed for a snapshot. Absent
   * where the surface cannot load one; a shared prototype then says it cannot
   * run here.
   */
  readonly resolveDesignPage?: (path: string) => string;
  /** Mint snapshot/export ids; defaults to `crypto.randomUUID`. Injectable for tests. */
  readonly newId?: () => string;
  /** Current time for expiry and consent stamps; the server stamps its own. */
  readonly now?: () => Date;
}

export function CanvasSharePanel(props: CanvasSharePanelProps) {
  const [run, setRun] = useState<ShareRun>({ kind: "idle" });
  const [openedSnapshot, setOpenedSnapshot] = useState<CanvasStaticExportDocument | undefined>(
    undefined,
  );
  const [openedAccess, setOpenedAccess] = useState<CanvasShareAccessRequest | undefined>(undefined);
  const [label, setLabel] = useState("This device");
  const [expiry, setExpiry] = useState<string>("24h");
  const [acknowledgedSnapshot, setAcknowledgedSnapshot] = useState(false);
  const [acknowledgedAudience, setAcknowledgedAudience] = useState(false);
  const [acknowledgedMarkup, setAcknowledgedMarkup] = useState(false);
  const holdsDesign = props.holdsDesign === true;
  const newId = props.newId ?? (() => crypto.randomUUID());
  const now = props.now ?? (() => new Date());
  const consented =
    acknowledgedSnapshot && acknowledgedAudience && (!holdsDesign || acknowledgedMarkup);
  // A shared prototype runs from a page the host tickets for this snapshot,
  // on the same read, and the same access-log entry, as opening it.
  const { onOpen, resolveDesignPage } = props;
  const snapshotRun = useMemo<DesignRunRuntime | undefined>(() => {
    if (openedAccess === undefined || resolveDesignPage === undefined) return undefined;
    return {
      start: async (blockId, frameId) => {
        const refused = {
          kind: "refused" as const,
          reason: "This prototype could not be started from the snapshot.",
        };
        // Decoded rather than asserted: the ids come from the drawn block.
        let request: CanvasShareAccessRequest;
        try {
          request = decodeCanvasShareAccessRequest({
            ...openedAccess,
            runDesign: { blockId, ...(frameId === undefined ? {} : { frameId }) },
          });
        } catch {
          return refused;
        }
        const result = await onOpen(request);
        return result.kind === "allowed" && result.designPage !== undefined
          ? { kind: "ready", url: resolveDesignPage(result.designPage) }
          : refused;
      },
      contained: runsInDesktopApp(),
      // Like the thread, a snapshot waits for the person to press Run.
      runsOnOpen: false,
    };
  }, [onOpen, openedAccess, resolveDesignPage]);
  const working = run.kind === "working";

  async function share() {
    const choice = EXPIRY_CHOICES.find((entry) => entry.id === expiry) ?? EXPIRY_CHOICES[1];
    const at = now();
    setRun({ kind: "working" });
    try {
      const result = await props.onShare({
        schemaVersion: 1,
        kind: "canvas-share-snapshot",
        snapshotId: newId() as CanvasShareSnapshotId,
        exportId: newId() as CanvasShareSnapshotRequest["exportId"],
        canvasId: props.canvasId,
        versionId: props.versionId,
        expectedSequence: props.expectedSequence,
        hostId: props.overview.hostId,
        projectId: props.overview.projectId,
        audience: {
          ownerActorId: props.overview.owner.actorId,
          principals: [
            {
              label: label.trim().length === 0 ? "This device" : label.trim(),
              principalKind: "local-user",
              principalId: props.overview.owner.actorId,
            },
          ],
        },
        expiresAt: new Date(at.getTime() + choice.ms).toISOString(),
        refreshPolicy: "manual-only",
        consent: {
          acknowledgedAuthenticatedSnapshot: true,
          acknowledgedOwnerVisibleAudience: true,
          ...(holdsDesign ? { acknowledgedMarkupSharedAsWritten: true } : {}),
          acknowledgedAt: at.toISOString(),
          acknowledgedBy: props.overview.owner,
        },
      } as unknown as CanvasShareSnapshotRequest);
      setRun(
        result.kind === "accepted"
          ? { kind: "done", text: "Snapshot shared." }
          : { kind: "failed", text: safeCanvasShareDenialReason(result.denialCode) },
      );
      if (result.kind === "accepted") {
        setAcknowledgedSnapshot(false);
        setAcknowledgedAudience(false);
        setAcknowledgedMarkup(false);
      }
    } catch {
      setRun({ kind: "failed", text: "The share could not be created." });
    }
  }

  async function revoke(snapshot: CanvasShareSnapshotSummary) {
    setRun({ kind: "working" });
    try {
      const result = await props.onRevoke({
        schemaVersion: 1,
        kind: "canvas-share-snapshot-revoke",
        snapshotId: snapshot.snapshotId,
        canvasId: snapshot.canvasId,
        hostId: snapshot.hostId,
        projectId: snapshot.projectId,
        actor: props.overview.owner,
        revokedAt: now().toISOString(),
      } as unknown as CanvasShareSnapshotRevokeRequest);
      setRun(
        result.kind === "accepted"
          ? { kind: "done", text: "Share revoked. It can no longer be opened." }
          : { kind: "failed", text: safeCanvasShareDenialReason(result.denialCode) },
      );
    } catch {
      setRun({ kind: "failed", text: "The share could not be revoked." });
    }
  }

  async function open(snapshot: CanvasShareSnapshotSummary) {
    setRun({ kind: "working" });
    setOpenedSnapshot(undefined);
    setOpenedAccess(undefined);
    try {
      const access = {
        schemaVersion: 1,
        kind: "canvas-share-access",
        snapshotId: snapshot.snapshotId,
        canvasId: snapshot.canvasId,
        hostId: snapshot.hostId,
        projectId: snapshot.projectId,
      } as unknown as CanvasShareAccessRequest;
      const result = await props.onOpen(access);
      if (result.kind === "allowed") {
        // Fail-closed render gate, mirroring the live canvas: the served
        // document is re-decoded against the sanitized export contract before
        // any block mounts, so a malformed payload is never shown.
        setOpenedSnapshot(decodeCanvasStaticExportDocument(result.document));
        setOpenedAccess(access);
        setRun({ kind: "done", text: ACCESS_COPY.allowed });
        return;
      }
      setRun({
        kind: "failed",
        text:
          result.kind === "denied"
            ? ACCESS_COPY[result.outcome]
            : safeCanvasShareDenialReason(result.denialCode),
      });
    } catch {
      setRun({ kind: "failed", text: "The snapshot could not be opened." });
    }
  }

  return (
    <section className="canvas-share" aria-label="Canvas sharing">
      <h3 className="canvas-share__title">Share</h3>
      <p className="canvas-share__description" id="canvas-share-description">
        A share is a read-only snapshot of this canvas version with credentials, file paths, and
        live sources stripped out. It stays on this Mac — nothing is uploaded, and there is no link.
        Only someone this host can sign in may open it, until it expires or you revoke it.
      </p>
      {props.overview.sharingEnabled ? (
        <div className="canvas-share__form">
          <label className="canvas-share__field">
            <span>Audience label</span>
            <OctantInput
              data-testid="canvas-share-label"
              disabled={working}
              maxLength={128}
              onChange={(event) => setLabel(event.target.value)}
              type="text"
              value={label}
            />
          </label>
          <label className="canvas-share__field">
            <span>Expires after</span>
            <OctantSelectField
              data-testid="canvas-share-expiry"
              disabled={working}
              onValueChange={(value) => setExpiry(value)}
              options={EXPIRY_CHOICES.map((choice) => ({
                id: choice.id,
                label: choice.label,
              }))}
              value={expiry}
            />
          </label>
          <p className="canvas-share__note">
            This host can only authenticate you right now, so this snapshot is addressed to you on
            this device.
          </p>
          <label className="canvas-share__consent">
            <OctantCheckbox
              checked={acknowledgedSnapshot}
              data-testid="canvas-share-consent-snapshot"
              onChange={(event) => setAcknowledgedSnapshot(event.target.checked)}
            />
            <span>This copies this canvas version into a snapshot that outlives the canvas.</span>
          </label>
          <label className="canvas-share__consent">
            <OctantCheckbox
              checked={acknowledgedAudience}
              data-testid="canvas-share-consent-audience"
              onChange={(event) => setAcknowledgedAudience(event.target.checked)}
            />
            <span>Everyone in the audience above can open it until it expires or I revoke it.</span>
          </label>
          {holdsDesign ? (
            <label className="canvas-share__consent">
              <OctantCheckbox
                checked={acknowledgedMarkup}
                data-testid="canvas-share-consent-markup"
                onChange={(event) => setAcknowledgedMarkup(event.target.checked)}
              />
              <span>
                This canvas holds a design. Its markup is shared exactly as written, and Octant does
                not check markup for secrets.
              </span>
            </label>
          ) : null}
          <OctantButton
            type="button"
            size="sm"
            variant="secondary"
            aria-describedby="canvas-share-description"
            aria-disabled={!consented || working ? true : undefined}
            data-testid="canvas-share-submit"
            onClick={() => {
              if (!consented || working) return;
              void share();
            }}
          >
            <Share2 aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Share snapshot</span>
          </OctantButton>
        </div>
      ) : (
        <p className="canvas-share__note" data-testid="canvas-share-disabled">
          Sharing is turned off on this host. This canvas still works normally here.
        </p>
      )}
      <ShareStatus run={run} />
      {openedSnapshot === undefined ? null : (
        <SharedSnapshotView
          document={openedSnapshot}
          onClose={() => {
            setOpenedSnapshot(undefined);
            setOpenedAccess(undefined);
          }}
          {...(snapshotRun === undefined ? {} : { designRun: snapshotRun })}
        />
      )}
      <ShareList
        snapshots={props.overview.snapshots}
        onOpen={(snapshot) => void open(snapshot)}
        onRevoke={(snapshot) => void revoke(snapshot)}
        working={working}
      />
      <AccessLog overview={props.overview} />
    </section>
  );
}

/**
 * Read-only view of an opened shared snapshot, labeled as the shared copy so
 * it is never mistaken for the live canvas. The snapshot cannot go through
 * `CanvasView`: its gate validates a full `CanvasDefinition`, and a sanitized
 * export document deliberately carries redacted provenance and no live
 * `sourceId` authority, so it would (correctly) fail that check. Its block
 * union is the same first-party catalog minus those authority fields — none of
 * which the block components read — so the blocks render through the existing
 * `CanvasBlockRenderer` rather than a second renderer.
 */
function SharedSnapshotView(props: {
  readonly document: CanvasStaticExportDocument;
  readonly onClose: () => void;
  readonly designRun?: DesignRunRuntime;
}) {
  const { designRun } = props;
  // A shared tab or column draws its children in place through the same
  // reading order as the live document, so a dashboard in a pane is the same
  // grid, and a placed block is never drawn a second time.
  const placed = (item: CanvasPlacedReadingItem<SharedBlock>): ReactNode =>
    item.kind === "block" ? (
      <SnapshotBlock block={item.block} designRun={designRun} key={item.block.blockId} />
    ) : (
      <section key={item.dashboard.blockId} className="canvas-block" data-block-kind="dashboard">
        <DashboardBlock
          headingLevel={6}
          title={item.dashboard.title}
          columns={item.columns}
          cells={item.cells}
          cellKey={(block) => block.blockId}
          cellKind={(block) => block.kind}
          renderCell={(block) => <SnapshotBlock block={block} designRun={designRun} />}
        />
      </section>
    );
  return (
    <section
      className="canvas-share__snapshot"
      aria-label="Shared snapshot"
      data-testid="canvas-share-snapshot-view"
    >
      <div className="canvas-share__snapshot-head">
        <h4 className="canvas-share__snapshot-title">Shared snapshot</h4>
        <OctantButton
          type="button"
          size="sm"
          variant="ghost"
          data-testid="canvas-share-snapshot-close"
          onClick={props.onClose}
        >
          Close
        </OctantButton>
      </div>
      <p className="canvas-share__note">
        This is the read-only snapshot the audience sees — not the live canvas.
      </p>
      <article className="canvas-share__snapshot-document" aria-label={props.document.title}>
        <h5 className="canvas-share__snapshot-document-title">{props.document.title}</h5>
        {canvasReadingOrder(props.document.blocks).map((item) =>
          item.kind === "group" ? (
            <CanvasLayoutGroup
              block={item.group as CanvasLayoutGroupBlock}
              key={item.group.blockId}
              renderSection={(index) => (item.sections[index] ?? []).map(placed)}
            />
          ) : (
            placed(item)
          ),
        )}
      </article>
    </section>
  );
}

type SharedBlock = CanvasStaticExportDocument["blocks"][number];

// A shared design is drawn by the same block the live Canvas uses, so its
// frames get the same sandbox and page policy; there is no second frame
// renderer for a snapshot to drift from.
function SnapshotBlock(props: {
  readonly block: SharedBlock;
  readonly designRun: DesignRunRuntime | undefined;
}) {
  return (
    <section className="canvas-block" data-block-kind={props.block.kind}>
      <CanvasBlockRenderer
        block={props.block as CanvasBlock}
        {...(props.designRun === undefined ? {} : { designRunRuntime: props.designRun })}
      />
    </section>
  );
}

function ShareStatus(props: { readonly run: ShareRun }) {
  const { run } = props;
  if (run.kind === "idle") return null;
  const failed = run.kind === "failed";
  return (
    /* ui-boundary-exception: compact-status */
    <p
      aria-live="polite"
      className="canvas-share__status"
      data-run={run.kind}
      data-testid="canvas-share-status"
      role={failed ? "alert" : "status"}
    >
      {run.kind === "done" ? (
        <Check aria-hidden="true" size={14} strokeWidth={2} />
      ) : failed ? (
        <Ban aria-hidden="true" size={14} strokeWidth={1.8} />
      ) : null}
      <span>{run.kind === "working" ? "Working…" : run.text}</span>
    </p>
  );
}

function ShareList(props: {
  readonly snapshots: ReadonlyArray<CanvasShareSnapshotSummary>;
  readonly onOpen: (snapshot: CanvasShareSnapshotSummary) => void;
  readonly onRevoke: (snapshot: CanvasShareSnapshotSummary) => void;
  readonly working: boolean;
}) {
  if (props.snapshots.length === 0) {
    return (
      <p className="canvas-share__note" data-testid="canvas-share-empty">
        Nothing is shared from this canvas.
      </p>
    );
  }
  return (
    <ul className="canvas-share__list" data-testid="canvas-share-list">
      {props.snapshots.map((snapshot) => (
        <li className="canvas-share__row" data-status={snapshot.status} key={snapshot.snapshotId}>
          <span className="canvas-share__row-status">
            {snapshot.status === "active" ? (
              <Check aria-hidden="true" size={14} strokeWidth={2} />
            ) : (
              <TriangleAlert aria-hidden="true" size={14} strokeWidth={1.8} />
            )}
            <span>
              {snapshot.status === "active"
                ? `Shared until ${formatMoment(snapshot.expiresAt)}`
                : snapshot.status === "revoked"
                  ? "Revoked"
                  : "Expired"}
            </span>
          </span>
          <span className="canvas-share__row-audience">
            {snapshot.audience.principals.map((principal) => principal.label).join(", ")}
          </span>
          <span className="canvas-share__row-actions">
            <OctantButton
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`canvas-share-open-${snapshot.snapshotId}`}
              onClick={() => props.onOpen(snapshot)}
            >
              <Eye aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Open</span>
            </OctantButton>
            {snapshot.status === "revoked" ? null : (
              <OctantButton
                type="button"
                size="sm"
                variant="ghost"
                aria-disabled={props.working ? true : undefined}
                data-testid={`canvas-share-revoke-${snapshot.snapshotId}`}
                onClick={() => {
                  if (props.working) return;
                  props.onRevoke(snapshot);
                }}
              >
                Revoke
              </OctantButton>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AccessLog(props: { readonly overview: CanvasShareOverview }) {
  const events = [...props.overview.accessLog].reverse();
  if (events.length === 0) return null;
  return (
    <div className="canvas-share__log">
      <h4 className="canvas-share__log-title">Who opened it</h4>
      <ul data-testid="canvas-share-access-log">
        {events.map((event) => (
          <li key={event.eventId}>
            <span>{ACCESS_COPY[event.outcome]}</span>{" "}
            <span className="canvas-share__log-meta">
              {formatMoment(event.occurredAt)} · {event.browserFamily}
              {event.audienceLabel === undefined ? "" : ` · ${event.audienceLabel}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatMoment(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}
