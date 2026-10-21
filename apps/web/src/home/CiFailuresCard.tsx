import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeProjectPullRequestView } from "@octant/contracts";
import { CircleX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import {
  buildCiFailureCard,
  CI_FAILURES_CARD_ID,
  type CiFailureCardRow,
  type CodeProjectCurrentBranch,
} from "./ciFailures";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";

export interface CiFailuresCardSource {
  readonly available: boolean;
  readonly viewerLogin: string;
  /** Branches the window already holds. The card does not look them up. */
  readonly currentBranches: ReadonlyArray<CodeProjectCurrentBranch>;
  /**
   * The one cached read the Pull requests workspace already uses. The card
   * calls it once when it mounts and does not poll.
   */
  readonly load: CodeClient["queryProjectPullRequests"];
  /** The clock the age labels read, advanced once a minute by the shell. */
  readonly now: number;
  /**
   * Opens a Code task draft in the failure's Project and branch, with the
   * prompt already written. The card never starts the turn.
   */
  readonly onStartFix: (row: CiFailureCardRow) => void;
}

/**
 * Failing checks on the person's open pull requests and the current branches
 * of Code Projects. Hidden unless the same read the Pull requests card uses
 * is allowed, and hidden when it has nothing to show.
 */
export function createCiFailuresCard(source: CiFailuresCardSource): HomeCardDefinition {
  return {
    id: CI_FAILURES_CARD_ID,
    title: "CI failures",
    icon: CircleX,
    defaultOn: true,
    available: source.available,
    hideWhenEmpty: true,
    emptyLabel: "Nothing is failing.",
    useContent: () => useCiFailuresContent(source),
  };
}

type FailureRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeProjectPullRequestView }
  | { readonly status: "unavailable" };

function useCiFailuresContent(source: CiFailuresCardSource): HomeCardContent {
  const read = useFailureRead(source.load);
  const { currentBranches, viewerLogin } = source;
  const model = useMemo(
    () =>
      read.status === "ready"
        ? buildCiFailureCard({ rows: read.view.rows, viewerLogin, currentBranches })
        : undefined,
    [currentBranches, read, viewerLogin],
  );
  if (read.status === "loading") return { status: "loading" };
  if (read.status === "unavailable" || model === undefined) {
    return { status: "ready", count: 0, body: null };
  }
  return {
    status: "ready",
    count: model.rows.length,
    body: <FailureRows now={source.now} onStartFix={source.onStartFix} rows={model.rows} />,
  };
}

/** One cached read when the card mounts. A later identity change reads again; nothing else does. */
function useFailureRead(load: CiFailuresCardSource["load"]): FailureRead {
  const [read, setRead] = useState<FailureRead>({ status: "loading" });
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

function FailureRows(props: {
  readonly rows: ReadonlyArray<CiFailureCardRow>;
  readonly now: number;
  readonly onStartFix: (row: CiFailureCardRow) => void;
}) {
  return (
    <ul className="ci-failures-card__list">
      {props.rows.map((row) => (
        <li key={row.key}>
          <div className="ci-failures-card__row">
            <span className="oct-row-label ci-failures-card__name">{row.checkName}</span>
            <span className="ci-failures-card__facts">
              <span className="oct-meta oct-meta--mono ci-failures-card__place">{row.place}</span>
              {row.failedAt === undefined ? null : (
                <span
                  className="oct-meta ci-failures-card__age"
                  title={absoluteTimeFormatter.format(new Date(row.failedAt))}
                >
                  {relativeTimeLabel(row.failedAt, props.now)}
                </span>
              )}
            </span>
            {row.branch === undefined ? null : (
              <OctantButton
                aria-label={`Start a fix for ${row.checkName} on ${row.place}`}
                className="ci-failures-card__fix window-no-drag"
                onClick={() => props.onStartFix(row)}
                size="sm"
                type="button"
                variant="link"
              >
                Start a fix
              </OctantButton>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
