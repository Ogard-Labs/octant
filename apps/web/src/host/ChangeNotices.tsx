import type { AccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type { ChangeNotice, ChangeNoticeList } from "@octant/contracts/access-activity";
import { useCallback, useEffect, useState } from "react";
import { PERMISSION_MODE_LABEL } from "../code/PermissionModePicker";
import { relativeTimeLabel } from "../lib/relativeTime";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/** A fallback for a surface without the change feed; the feed refreshes it at once. */
const REFRESH_MS = 30_000;

export interface ChangeNoticesProps {
  readonly client: AccessActivityClient;
  /** Advances when the host journals a raised level, a key change, or a dismissal. */
  readonly changeRevision?: number;
}

/**
 * The change notices this client may see, kept fresh by the change feed, and
 * the action that runs one. A refused read keeps what is shown: a notice must
 * not vanish because one read failed.
 */
export function useChangeNotices(client: AccessActivityClient, changeRevision?: number) {
  const [list, setList] = useState<ChangeNoticeList>();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  const refresh = useCallback(async () => {
    const read = await client.readNotices();
    if (read !== undefined) setList(read);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, changeRevision]);
  useEffect(() => scheduleVisibleInterval(() => void refresh(), REFRESH_MS), [refresh]);

  const act = useCallback(
    async (action: "dismiss" | "undo" | "revoke", noticeId: string) => {
      setBusy(true);
      setRefusal(undefined);
      try {
        const result = await client.act(action, noticeId);
        if (result.status === "refused") setRefusal(result.message);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );
  return { notices: list?.notices ?? [], busy, refusal, act };
}

/**
 * Tells the person, in the app only, that a paired device or an agent raised
 * a thread's level or added or replaced a provider key, with Undo and a way
 * to revoke whoever did it (maintainer decision, 2026-11-22). The host decides
 * which notices this client sees and whether each action may run.
 */
export function ChangeNotices(props: ChangeNoticesProps) {
  const { notices, busy, refusal, act } = useChangeNotices(props.client, props.changeRevision);
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
                disabled={busy}
                onClick={() => void act("revoke", notice.noticeId)}
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
    </section>
  );
}

/** One line naming who changed what. */
export function describeNotice(notice: ChangeNotice): string {
  const who = notice.actor.kind === "agent" ? `The agent ${notice.actor.name}` : notice.actor.label;
  if (notice.kind === "thread-level-raised") {
    const thread = notice.threadTitle === undefined ? "a thread" : `“${notice.threadTitle}”`;
    return `${who} raised ${thread} from ${PERMISSION_MODE_LABEL[notice.from]} to ${PERMISSION_MODE_LABEL[notice.to]}`;
  }
  const provider = notice.providerName ?? "a provider";
  return notice.kind === "provider-key-added"
    ? `${who} added a key for ${provider}`
    : `${who} replaced the key for ${provider}`;
}
