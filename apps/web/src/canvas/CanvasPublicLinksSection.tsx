import type { CanvasId } from "@octant/contracts/canvas";
import type {
  CanvasPublicShareList,
  CanvasPublicShareRecord,
  CanvasPublicShareRevokeRequest,
  CanvasPublicShareRevokeResult,
} from "@octant/contracts/canvas-public-share";
import { useCallback, useEffect, useState } from "react";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";

export interface CanvasPublicLinksSectionProps {
  readonly canvasId: CanvasId;
  readonly onList: (canvasId: CanvasId) => Promise<CanvasPublicShareList>;
  readonly onRevoke: (
    request: CanvasPublicShareRevokeRequest,
  ) => Promise<CanvasPublicShareRevokeResult>;
  /** Opens the export dialog on the Public link destination to replace a link's content. */
  readonly onUpdate: () => void;
  /** Changes when the list should be read again, such as after an export. */
  readonly revision?: number;
  /** Writes text to the clipboard; defaults to the browser's. */
  readonly copyText?: (text: string) => Promise<void>;
}

const STATUS_LABEL: Record<CanvasPublicShareRecord["status"], string> = {
  active: "Active",
  expired: "Expired",
  revoking: "Revoking",
  revoked: "Revoked",
};

/**
 * The links published from one Canvas. The host keeps each link's owner
 * secret and never sends it here; a window sees the address, the terms, and
 * the status, and can ask the host to revoke.
 */
export function CanvasPublicLinksSection(props: CanvasPublicLinksSectionProps) {
  const { canvasId, onList } = props;
  const [list, setList] = useState<CanvasPublicShareList | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState<CanvasPublicShareRecord | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setList(await onList(canvasId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [canvasId, onList]);

  useEffect(() => {
    void load();
  }, [load, props.revision]);

  async function copy(url: string) {
    try {
      await (props.copyText ?? ((text) => navigator.clipboard.writeText(text)))(url);
      setNotice("Link copied.");
    } catch {
      setNotice("The link could not be copied.");
    }
  }

  async function revoke(share: CanvasPublicShareRecord) {
    setBusy(true);
    try {
      const result = await props.onRevoke({
        schemaVersion: 1,
        kind: "canvas-public-share-revoke",
        canvasId,
        publicShareId: share.publicShareId,
      });
      setNotice(
        result.kind === "revoked"
          ? "Link revoked. It no longer opens."
          : // Both carry the host's own words: a revoking link is still
            // reachable until the service answers.
            result.message,
      );
      setRevoking(undefined);
      await load();
    } catch {
      setNotice("The link could not be revoked.");
      setRevoking(undefined);
    } finally {
      setBusy(false);
    }
  }

  if (failed && list === undefined) {
    return (
      <p className="canvas-share__note" role="status">
        Public links could not be read from this host.
      </p>
    );
  }
  if (list === undefined) return null;
  if (!list.enabled && list.shares.length === 0) {
    return (
      <p className="canvas-share__note" data-testid="canvas-public-links-off">
        Public links are off. Turn them on in Settings › Data & privacy › Public links.
      </p>
    );
  }
  return (
    <section
      aria-label="Public links"
      className="canvas-public-links"
      data-testid="canvas-public-links"
    >
      <h4 className="canvas-share__log-title">Public links</h4>
      {list.shares.length === 0 ? (
        <p className="canvas-share__note">No public link is published from this canvas.</p>
      ) : (
        <ul className="canvas-share__list">
          {list.shares.map((share) => (
            <li
              className="canvas-share__row"
              data-status={share.status}
              data-testid={`canvas-public-link-${share.publicShareId}`}
              key={share.publicShareId}
            >
              <span className="canvas-public-links__url">{share.url}</span>
              <span className="canvas-share__row-status">
                <span>{STATUS_LABEL[share.status]}</span>
                <span>·</span>
                <span>
                  {share.expiresAt === null
                    ? "Never expires"
                    : `Expires ${formatMoment(share.expiresAt)}`}
                </span>
                {share.passwordProtected ? (
                  <OctantBadge variant="outline">Password</OctantBadge>
                ) : null}
              </span>
              {share.status === "revoked" ? null : (
                <span className="canvas-share__row-actions">
                  <OctantButton
                    onClick={() => void copy(share.url)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Copy link
                  </OctantButton>
                  {share.status === "active" ? (
                    <OctantButton onClick={props.onUpdate} size="sm" type="button" variant="ghost">
                      Update
                    </OctantButton>
                  ) : null}
                  {share.status === "revoking" ? null : (
                    <OctantButton
                      disabled={busy}
                      onClick={() => setRevoking(share)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Revoke
                    </OctantButton>
                  )}
                </span>
              )}
              {share.status === "revoking" ? (
                <span className="canvas-share__note">
                  The service has not confirmed yet. This host keeps trying, and the link may still
                  open until it does.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {notice === undefined ? null : (
        <p className="canvas-share__note" role="status">
          {notice}
        </p>
      )}
      {revoking === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Revoke link"
          destructive
          onCancel={() => setRevoking(undefined)}
          onConfirm={() => void revoke(revoking)}
          pending={busy}
          title="Revoke this public link?"
        >
          Anyone who has {revoking.url} will no longer be able to open it.
        </OctantConfirmDialog>
      )}
    </section>
  );
}

function formatMoment(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}
