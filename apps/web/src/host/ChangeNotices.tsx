import type { AccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type { ChangeNotice } from "@octant/contracts/access-activity";
import { useCallback, useRef, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { describeNotice, useChangeNotices, type ChangeNoticeAction } from "./changeNoticeState";

/**
 * A local window's own controls for the changes the host takes from a window
 * only through the desktop bridge: undoing a key change, revoking a paired
 * device, ending an agent grant. Each throws when the host refuses it. A paired
 * device has none and acts through the notice routes.
 */
export interface ChangeNoticeLocalActions {
  /**
   * The host's own journaled Undo of a notice's key change, through the
   * desktop bridge. Absent on an older build, where Undo refuses rather than
   * falling back to an ordinary key removal.
   */
  readonly undoAccessChangeNotice?: (noticeId: string) => Promise<void>;
  readonly revokeDevice: (deviceId: string) => Promise<unknown>;
  readonly endAgentGrant: (grantId: string) => Promise<void>;
}

export interface ChangeNoticesProps {
  readonly client: AccessActivityClient;
  readonly localActions?: ChangeNoticeLocalActions;
  /** Advances when the host journals a raised level, a key change, or a dismissal. */
  readonly changeRevision?: number;
}

/**
 * Tells the person, in the app only, that a paired device or an agent raised
 * a thread's level or added or replaced a provider key, with Undo and a way
 * to revoke whoever did it (maintainer decision, 2026-11-22). The host decides
 * which notices this client sees and whether each action may run.
 */
export function ChangeNotices(props: ChangeNoticesProps) {
  const { client, localActions } = props;
  const runLocally = useCallback(
    (action: ChangeNoticeAction, noticeId: string) =>
      localActions === undefined
        ? Promise.resolve("not-local" as const)
        : actLocally(client, localActions, action, noticeId),
    [client, localActions],
  );
  const { notices, busy, refusal, act } = useChangeNotices(
    client,
    props.changeRevision,
    runLocally,
  );
  // Revoking a device or ending a grant is destructive, so it asks first, as
  // the same controls in Settings do.
  const [confirmingRevoke, setConfirmingRevoke] = useState<ChangeNotice | undefined>(undefined);
  const revokeOpener = useRef<HTMLButtonElement | null>(null);
  if (notices.length === 0) return null;

  return (
    <section aria-label="Access changes">
      {refusal === undefined ? null : <OctantAlert tone="warning">{refusal}</OctantAlert>}
      <ul className="setgroup">
        {notices.map((notice) => (
          <li className="setrow" key={notice.noticeId}>
            <span className="setrow-label">{describeNotice(notice)}</span>
            <p className="setrow-hint">
              <time dateTime={notice.at}>{relativeTimeLabel(notice.at)}</time>
              {notice.kind === "provider-key-replaced"
                ? " · No Undo: the earlier key is not kept."
                : null}
            </p>
            <div className="setrow-control">
              {notice.kind === "provider-key-replaced" ? null : (
                <OctantButton
                  disabled={busy}
                  onClick={() => void act("undo", notice.noticeId)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Undo
                </OctantButton>
              )}
              <OctantButton
                aria-haspopup="dialog"
                disabled={busy}
                onClick={(event) => {
                  revokeOpener.current = event.currentTarget;
                  setConfirmingRevoke(notice);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {notice.actor.kind === "agent"
                  ? `End ${notice.actor.name}'s access`
                  : `Revoke ${notice.actor.label}`}
              </OctantButton>
              <OctantButton
                aria-label={`Dismiss: ${describeNotice(notice)}`}
                disabled={busy}
                onClick={() => void act("dismiss", notice.noticeId)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Dismiss
              </OctantButton>
            </div>
          </li>
        ))}
      </ul>
      <OctantDialogPresence>
        {confirmingRevoke === undefined ? null : (
          <OctantConfirmDialog
            cancelLabel="Keep it"
            destructive
            confirmLabel={confirmingRevoke.actor.kind === "agent" ? "End access" : "Revoke device"}
            onCancel={() => setConfirmingRevoke(undefined)}
            onConfirm={() => {
              const notice = confirmingRevoke;
              setConfirmingRevoke(undefined);
              void act("revoke", notice.noticeId);
            }}
            restoreFocus={revokeOpener}
            title={
              confirmingRevoke.actor.kind === "agent"
                ? `End ${confirmingRevoke.actor.name}'s access?`
                : `Revoke ${confirmingRevoke.actor.label}?`
            }
          >
            {confirmingRevoke.actor.kind === "agent"
              ? "The agent's access to this computer ends now."
              : "The device loses access to this computer and must pair again to return."}
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </section>
  );
}

/**
 * Runs a window's key Undo or revoke through this computer's own controls,
 * after a fresh read confirms the notice is still current, then dismisses it.
 * Answers the refusal to show, nothing when done, or `not-local` for an
 * action the notice routes take from a window (a thread level's Undo, Dismiss).
 */
async function actLocally(
  client: AccessActivityClient,
  local: ChangeNoticeLocalActions,
  action: ChangeNoticeAction,
  noticeId: string,
): Promise<string | "not-local" | undefined> {
  if (action === "dismiss") return "not-local";
  const notice = (await client.readNotices())?.notices.find(
    (candidate) => candidate.noticeId === noticeId,
  );
  if (notice === undefined) return "That notice is gone or was already handled.";
  if (action === "undo" && notice.kind === "thread-level-raised") return "not-local";
  try {
    if (action === "undo") {
      if (notice.kind !== "provider-key-added") {
        return "A replaced key cannot be undone: the earlier key is not kept.";
      }
      if (notice.keyId === undefined) {
        return "This provider's keys changed again since, so Undo could remove the wrong key. Check its keys in Settings.";
      }
      if (local.undoAccessChangeNotice === undefined) {
        return "This build cannot undo a key change from a window; act on this computer directly.";
      }
      // The host journals the Undo, dismissal included: nothing more to ask.
      await local.undoAccessChangeNotice(notice.noticeId);
      return undefined;
    } else if (notice.actor.kind === "agent") {
      await local.endAgentGrant(notice.actor.grantId);
    } else {
      await local.revokeDevice(notice.actor.deviceId);
    }
  } catch (error) {
    return error instanceof Error && error.message !== "" ? error.message : "That did not work.";
  }
  const dismissed = await client.act("dismiss", noticeId);
  return dismissed.status === "refused" ? dismissed.message : undefined;
}
