import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeProjectPullRequestView } from "@octant/contracts";
import { GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import {
  buildPullRequestCard,
  PULL_REQUESTS_CARD_ID,
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
  readonly onOpenRow: (row: PullRequestCardRow) => void;
  /** Opens the Pull requests workspace, which lists every row the card cannot fit. */
  readonly onOpenAll: () => void;
}

/**
 * Pull requests across every Code Project this window can access, in two
 * groups. Hidden unless the Pull requests destination's capability allows
 * the read. It reads the cached list once; the host's existing refresh
 * cadence is what moves that list.
 */
export function createPullRequestsCard(source: PullRequestsCardSource): HomeCardDefinition {
  return {
    id: PULL_REQUESTS_CARD_ID,
    title: "Pull requests",
    icon: GitPullRequest,
    defaultOn: true,
    available: source.available,
    emptyLabel: "Nothing is waiting on you.",
    useContent: () => usePullRequestsContent(source),
  };
}

type PullRequestRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeProjectPullRequestView }
  | { readonly status: "unavailable" };

function usePullRequestsContent(source: PullRequestsCardSource): HomeCardContent {
  const read = usePullRequestRead(source.load);
  const { viewerLogin } = source;
  const model = useMemo(
    () =>
      read.status === "ready"
        ? buildPullRequestCard({ rows: read.view.rows, viewerLogin })
        : undefined,
    [read, viewerLogin],
  );
  if (read.status === "loading") return { status: "loading" };
  if (read.status === "unavailable" || model === undefined) {
    return { status: "ready", count: 0, body: null };
  }
  return {
    status: "ready",
    count: model.total,
    body: (
      <PullRequestRows model={model} onOpenAll={source.onOpenAll} onOpenRow={source.onOpenRow} />
    ),
  };
}

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

function PullRequestRows(props: {
  readonly model: ReturnType<typeof buildPullRequestCard>;
  readonly onOpenRow: (row: PullRequestCardRow) => void;
  readonly onOpenAll: () => void;
}) {
  return (
    <>
      <PullRequestGroup
        label="Waiting on your review"
        onOpenRow={props.onOpenRow}
        rows={props.model.waiting}
      />
      <PullRequestGroup label="Yours" onOpenRow={props.onOpenRow} rows={props.model.yours} />
      {props.model.hidden <= 0 ? null : (
        <OctantButton
          className="pull-requests-card__more window-no-drag"
          onClick={props.onOpenAll}
          size="sm"
          type="button"
          variant="link"
        >
          {`+${String(props.model.hidden)} more`}
        </OctantButton>
      )}
    </>
  );
}

function PullRequestGroup(props: {
  readonly label: string;
  readonly rows: ReadonlyArray<PullRequestCardRow>;
  readonly onOpenRow: (row: PullRequestCardRow) => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section className="pull-requests-card__group">
      <h3 className="oct-meta pull-requests-card__heading">{props.label}</h3>
      <ul className="pull-requests-card__list">
        {props.rows.map((row) => (
          <li key={row.key}>
            <OctantButton
              className="pull-requests-card__row window-no-drag"
              onClick={() => props.onOpenRow(row)}
              type="button"
              variant="bare"
            >
              <span className="pull-requests-card__face">
                <span className="oct-row-label pull-requests-card__title">{row.title}</span>
                <span className="pull-requests-card__facts">
                  <span className="oct-meta oct-meta--mono pull-requests-card__reference">
                    {row.reference}
                  </span>
                  <span className="oct-meta pull-requests-card__ci" data-ci={row.ci}>
                    {row.ci}
                  </span>
                  <span className="oct-meta pull-requests-card__review" data-review={row.review}>
                    {row.review}
                  </span>
                </span>
              </span>
            </OctantButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
