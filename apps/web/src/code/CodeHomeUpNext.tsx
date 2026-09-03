import { useEffect, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubAssignedWorkItem } from "@octant/contracts";
import { CircleDot, GitPullRequest } from "lucide-react";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";

const UP_NEXT_LIMIT = 6;

const CATEGORY_LABELS: Readonly<Record<GithubAssignedWorkItem["category"], string>> = {
  issue: "Issue",
  "pull-request": "Pull request",
  "review-request": "Review requested",
};

type UpNextState =
  | { readonly kind: "loading" }
  | { readonly kind: "hidden" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly items: ReadonlyArray<GithubAssignedWorkItem> };

export interface CodeHomeUpNextProps {
  readonly client: GithubClient;
  /** Starts a thread from the item: the caller fills the prompt and attaches the context. */
  readonly onPick: (item: GithubAssignedWorkItem) => void;
}

/**
 * What GitHub is waiting on the signed-in account for, shown under the Code
 * composer so the start screen offers real next work instead of a blank
 * prompt. GitHub being disconnected hides the section rather than
 * apologising for it; a failed read says so in one line.
 */
export function CodeHomeUpNext(props: CodeHomeUpNextProps) {
  const { client } = props;
  const [state, setState] = useState<UpNextState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    client.readCatalogue({ kind: "assigned-work" }).then(
      (response) => {
        if (cancelled) return;
        if (response.kind === "assigned-work") {
          setState({
            kind: "ready",
            items: [...response.page.items]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, UP_NEXT_LIMIT),
          });
        } else if (response.kind === "unavailable") {
          setState({ kind: "hidden" });
        } else {
          setState({ kind: "failed", message: "GitHub returned an unexpected response." });
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "failed",
          message: error instanceof Error ? error.message : "GitHub could not be reached.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (state.kind === "hidden") return null;
  return (
    <section aria-label="Up next" className="code-home__section">
      <p className="code-home__section-title">Up next</p>
      {state.kind === "loading" ? (
        <p className="code-home__note" role="status">
          Checking what is assigned to you…
        </p>
      ) : state.kind === "failed" ? (
        <p className="code-home__note" role="status">
          {state.message}
        </p>
      ) : state.items.length === 0 ? (
        <p className="code-home__note" role="status">
          You're all caught up.
        </p>
      ) : (
        <ul className="code-home__list">
          {state.items.map((item) => {
            const Icon = item.category === "issue" ? CircleDot : GitPullRequest;
            return (
              <li key={`${item.owner}/${item.name}#${item.number}`}>
                <OctantButton
                  className="code-home__row"
                  onClick={() => props.onPick(item)}
                  type="button"
                  variant="ghost"
                >
                  <Icon
                    aria-hidden="true"
                    className="code-home__row-icon"
                    size={14}
                    strokeWidth={1.7}
                  />
                  <span className="code-home__row-copy">
                    <span className="code-home__row-title">{item.title}</span>
                    <span className="code-home__row-meta">
                      {CATEGORY_LABELS[item.category]} · {item.owner}/{item.name}#{item.number} ·{" "}
                      <span title={absoluteTimeFormatter.format(new Date(item.updatedAt))}>
                        {relativeTimeLabel(item.updatedAt)}
                      </span>
                    </span>
                  </span>
                </OctantButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
