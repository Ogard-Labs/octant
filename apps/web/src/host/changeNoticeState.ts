import type { AccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type { ChangeNotice, ChangeNoticeList } from "@octant/contracts/access-activity";
import { useCallback, useEffect, useState } from "react";
import { PERMISSION_MODE_LABEL } from "../code/PermissionModePicker";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

/**
 * The change notice state a window's notice stack needs, kept apart from the
 * Settings list (`ChangeNotices`) so the app's first load carries only this.
 */

/** A fallback for a surface without the change feed; the feed refreshes it at once. */
const REFRESH_MS = 30_000;

export type ChangeNoticeAction = "dismiss" | "undo" | "revoke";

/**
 * Runs an action through this computer's own controls instead of the notice
 * routes. Answers the refusal to show, nothing when done, or `not-local` for
 * an action the notice routes take.
 */
export type ChangeNoticeLocalRunner = (
  action: ChangeNoticeAction,
  noticeId: string,
) => Promise<string | "not-local" | undefined>;

/**
 * The change notices this client may see, kept fresh by the change feed, and
 * the action that runs one. A refused read keeps what is shown: a notice must
 * not vanish because one read failed.
 */
export function useChangeNotices(
  client: AccessActivityClient,
  changeRevision?: number,
  runLocally?: ChangeNoticeLocalRunner,
) {
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
    async (action: ChangeNoticeAction, noticeId: string) => {
      setBusy(true);
      setRefusal(undefined);
      try {
        const local = runLocally === undefined ? "not-local" : await runLocally(action, noticeId);
        if (local === "not-local") {
          const result = await client.act(action, noticeId);
          if (result.status === "refused") setRefusal(result.message);
        } else if (local !== undefined) setRefusal(local);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [client, runLocally, refresh],
  );
  return { notices: list?.notices ?? [], busy, refusal, act };
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
