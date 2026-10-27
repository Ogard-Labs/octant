import type { FollowUpSuggestionClient } from "@octant/client-runtime/follow-up-suggestion-client";
import { createContext, useCallback, useState, type ReactNode } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

const NO_LINKS: ReadonlyMap<string, string> = new Map();

/**
 * The thread each follow-up-created thread was started from, by its own id.
 * The sidebar nests a thread under the one that suggested it when both are
 * in the same list.
 */
export const FollowUpLineageContext = createContext<ReadonlyMap<string, string>>(NO_LINKS);

/**
 * How often the links are read again. A new link appears when a person starts
 * a suggested task in this window, which already opens that thread, so the
 * nesting can follow a beat later.
 */
const REREAD_MS = 15_000;

export function FollowUpLineageProvider(props: {
  readonly client: Pick<FollowUpSuggestionClient, "lineage"> | undefined;
  readonly children: ReactNode;
}) {
  const [parents, setParents] = useState<ReadonlyMap<string, string>>(NO_LINKS);
  const client = props.client;
  const revision = useThreadActivityRevision("threadFollowUps");
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined) return;
      try {
        const lineage = await client.lineage();
        if (signal.aborted) return;
        setParents((current) => {
          const next = new Map(
            lineage.links.map((link) => [String(link.threadId), String(link.parentThreadId)]),
          );
          return sameLinks(current, next) ? current : next;
        });
      } catch {
        // Nesting is presentation; a failed read keeps the last answer.
      }
    },
    [client],
  );
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? REREAD_MS : THREAD_ACTIVITY_RECOVERY_MS,
  );
  return <FollowUpLineageContext value={parents}>{props.children}</FollowUpLineageContext>;
}

function sameLinks(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  if (left.size !== right.size) return false;
  for (const [child, parent] of right) if (left.get(child) !== parent) return false;
  return true;
}
