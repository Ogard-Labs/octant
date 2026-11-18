import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeProjectPullRequestView } from "@octant/contracts";
import { GitPullRequest } from "../ui/icons";
import { useEffect, useMemo, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import type { HomeListCardDefinition, HomeListRead } from "./homeCards";
import { pullRequestListRow } from "./homeListRows";
import { useMinuteNow } from "../polling/useMinuteTick";
import {
  buildPullRequestCard,
  PULL_REQUESTS_CARD_ID,
  pullRequestSnapshotReach,
  type PullRequestCardRow,
} from "./pullRequests";

export interface PullRequestsCardSource {
  readonly available: boolean;
  /** The signed-in login. Unused while the card is hidden. */
  readonly viewerLogin: string;
  /**
   * The one cached read the Pull requests workspace already uses. The card
   * calls it once when it mounts and does not poll.
   */
  readonly load: CodeClient["queryProjectPullRequests"];
  /** The clock the snapshot's age reads, advanced once a minute by the shell. */
  readonly now: number;
  readonly onOpenRow: (row: PullRequestCardRow) => void;
  /** Opens the Pull requests workspace, which lists every row the card cannot fit. */
  readonly onOpenAll: () => void;
}

/**
 * Pull requests across every Code Project this window can access, in two
 * groups. Hidden unless the Pull requests destination's capability allows
 * the read. It reads the cached list once; an explicit refresh, or a
 * Project's opt-in refresh cadence, is what moves that list. It says nothing
 * is waiting only when a refresh has reached every connected Project.
 */
export function createPullRequestsCard(source: PullRequestsCardSource): HomeListCardDefinition {
  return {
    id: PULL_REQUESTS_CARD_ID,
    title: "Pull requests",
    icon: GitPullRequest,
    defaultOn: true,
    available: source.available,
    useListRows: () => usePullRequestsListRows(source),
  };
}

/**
 * The card's two groups as rows of the start screen's list: the pull requests
 * waiting on the person's review under Needs you, their own under Your pull
 * requests. It still says when it has not looked at every Project, because a
 * quiet list would otherwise read as "nothing is waiting".
 */
function usePullRequestsListRows(source: PullRequestsCardSource): HomeListRead {
  const read = usePullRequestRead(source.load);
  const { onOpenAll, onOpenRow, viewerLogin } = source;
  // The card is built once, so `source.now` is the clock at creation; the
  // caveat still has to age with the minute.
  const now = useMinuteNow(source.now);
  const model = useMemo(
    () =>
      read.status === "ready"
        ? buildPullRequestCard({ rows: read.view.rows, viewerLogin })
        : undefined,
    [read, viewerLogin],
  );
  if (read.status === "loading") return { status: "loading" };
  if (read.status === "unavailable" || model === undefined) {
    return {
      status: "ready",
      rows: [],
      caveat: { text: "Octant could not read pull requests." },
    };
  }
  const reach = pullRequestSnapshotReach(read.view);
  // A failed refresh keeps the last snapshot, so its rows and its silence are
  // only as current as the last refresh that succeeded.
  const { freshness } = read.view;
  const checkedAt = freshness.status === "stale" ? freshness.lastSuccessfulRefreshAt : undefined;
  const caveat =
    reach !== "checked"
      ? {
          text:
            reach === "unchecked"
              ? "Pull requests have not been checked yet."
              : "Some Projects have not been checked yet.",
          action: { label: "Open Pull requests", onSelect: onOpenAll },
        }
      : checkedAt === undefined
        ? undefined
        : {
            text:
              model.total === 0
                ? `Nothing was waiting on you when checked ${relativeTimeLabel(checkedAt, now)}.`
                : `Pull requests last checked ${relativeTimeLabel(checkedAt, now)}.`,
          };
  return {
    status: "ready",
    seeAll: {
      "needs-you": { label: "See all", onSelect: onOpenAll },
      "your-pull-requests": { label: "See all", onSelect: onOpenAll },
    },
    ...(caveat === undefined ? {} : { caveat }),
    rows: [
      ...model.everyWaiting.map((row) =>
        pullRequestListRow(row, "needs-you", now, () => onOpenRow(row)),
      ),
      ...model.everyYours.map((row) =>
        pullRequestListRow(row, "your-pull-requests", now, () => onOpenRow(row)),
      ),
    ],
  };
}

type PullRequestRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeProjectPullRequestView }
  | { readonly status: "unavailable" };

/** One cached read when the card mounts. A later identity change reads again; nothing else does. */
function usePullRequestRead(load: PullRequestsCardSource["load"]): PullRequestRead {
  const [read, setRead] = useState<PullRequestRead>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setRead({ status: "loading" });
    load({ version: 1 }).then(
      (view) => {
        if (active) setRead({ status: "ready", view });
      },
      () => {
        if (active) setRead({ status: "unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [load]);
  return read;
}
