import "./project-pull-request-stack.css";
import type { OwnerUnlockNotGiven } from "@octant/client-runtime";
import {
  MAX_CODE_PROJECT_PULL_REQUEST_STACK_MERGE,
  type CodeProjectPullRequestDetailView,
  type CodeProjectPullRequestMergeMethod,
  type CodeProjectPullRequestRow,
  type CodeProjectPullRequestStackMergeOutcome,
} from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { pullRequestRowStateMark } from "./pullRequestState";
import {
  reviewStack,
  stackMergeOutcomeCopy,
  type ReviewedStack,
  type ReviewedStackLayer,
} from "./pullRequestStack";
import { stackJoin } from "./stackPlace";

const METHOD_WORDS: Readonly<Record<CodeProjectPullRequestMergeMethod, string>> = {
  merge: "a merge commit each",
  squash: "squash and merge",
  rebase: "rebase and merge",
};

export interface StackMergeResult {
  readonly text: string;
  readonly merged: boolean;
}

export interface ProjectPullRequestStackProps {
  /** Bottom first, two or more, with the open pull request among them. */
  readonly layers: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly number: number;
  readonly method: CodeProjectPullRequestMergeMethod;
  /** The snapshot was cut at its bound, so a layer may be missing from it. */
  readonly partial: boolean;
  /** Reads one layer from GitHub, so the confirmation names the head it would merge. */
  readonly readLayer: (
    layer: CodeProjectPullRequestRow,
  ) => Promise<CodeProjectPullRequestDetailView>;
  /** Absent where the host merges no stack. */
  readonly onMergeStack?:
    | ((
        method: CodeProjectPullRequestMergeMethod,
        stack: {
          readonly layers: ReadonlyArray<ReviewedStackLayer>;
          readonly destination: string;
        },
      ) => Promise<CodeProjectPullRequestStackMergeOutcome | OwnerUnlockNotGiven>)
    | undefined;
  /**
   * Told what landed and why it stopped. The stack may be gone once the review
   * is read again, so the result is the review's to show, not this section's.
   */
  readonly onSettled: (result: StackMergeResult) => void;
}

type MergeState =
  | { readonly step: "idle" }
  | { readonly step: "reading" }
  | { readonly step: "reviewed"; readonly stack: ReviewedStack }
  | {
      readonly step: "merging";
      /** What was sent: the page's method menu stays open to change meanwhile. */
      readonly method: CodeProjectPullRequestMergeMethod;
      readonly stack: Extract<ReviewedStack, { readonly status: "ready" }>;
    };

/**
 * The stack a pull request belongs to, bottom first, and on its bottom layer
 * the one step that lands all of it. Merging reads every layer again first: the
 * list is a cached snapshot, and a person confirms heads, not a remembered order.
 */
export function ProjectPullRequestStack(props: ProjectPullRequestStackProps) {
  const [state, setState] = useState<MergeState>({ step: "idle" });
  const cancelButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const { layers } = props;
  const bottom = layers[0];
  const isBottom = bottom?.number === props.number;
  const tooLong = layers.length > MAX_CODE_PROJECT_PULL_REQUEST_STACK_MERGE;

  useEffect(() => {
    if (state.step === "reviewed") cancelButton.current?.focus();
  }, [state.step]);

  if (bottom === undefined) return null;

  async function review(): Promise<void> {
    setState({ step: "reading" });
    try {
      const views = await Promise.all(layers.map((layer) => props.readLayer(layer)));
      setState({ step: "reviewed", stack: reviewStack(views) });
    } catch {
      setState({
        step: "reviewed",
        stack: { status: "blocked", reason: "The stack could not be read from GitHub." },
      });
    }
  }

  function cancel(): void {
    setState({ step: "idle" });
    opener.current?.focus();
  }

  async function confirm(
    stack: Extract<ReviewedStack, { readonly status: "ready" }>,
  ): Promise<void> {
    if (props.onMergeStack === undefined) return;
    const { method } = props;
    setState({ step: "merging", method, stack });
    let result: StackMergeResult;
    try {
      const outcome = await props.onMergeStack(method, stack);
      result = { text: stackMergeOutcomeCopy(outcome), merged: outcome.status === "merged" };
    } catch {
      // The request may have reached the host, so it is not said that nothing merged.
      result = {
        text: "This computer did not answer. Check each layer before merging again.",
        merged: false,
      };
    }
    setState({ step: "idle" });
    props.onSettled(result);
  }

  const items = layers.map((layer, index) => ({
    identity: layer,
    stack: {
      position: index + 1,
      size: layers.length,
      ...(index === 0 ? {} : { parent: layers[index - 1]?.number }),
    },
  }));
  const open = state.step === "reviewed" || state.step === "merging" ? state.stack : undefined;
  const merging = state.step === "merging";
  const method = state.step === "merging" ? state.method : props.method;

  return (
    <section aria-label="Stack" className="pr-detail__group code-pr-stack">
      <h2 className="oct-nav-group">Stack of {layers.length}</h2>
      <ol className="code-pr-stack__list">
        {layers.map((layer, index) => {
          const mark = pullRequestRowStateMark(layer);
          return (
            <li
              aria-current={layer.number === props.number ? "true" : undefined}
              className="code-pr-stack__layer"
              data-stack-join={stackJoin(items, index)}
              key={layer.number}
            >
              <span
                aria-label={mark.label}
                className="code-pr-stack__state"
                data-pr-state={mark.tone}
                role="img"
              >
                <mark.Icon aria-hidden="true" size={14} />
              </span>
              <span className="code-pr-stack__number">#{layer.number}</span>
              <span className="code-pr-stack__title" title={layer.title}>
                {layer.title}
              </span>
            </li>
          );
        })}
      </ol>
      {props.partial ? (
        <p className="code-pr-stack__note">
          The list is cut at its limit, so this stack may have more layers.
        </p>
      ) : null}
      {props.onMergeStack === undefined ? null : !isBottom ? (
        <p className="code-pr-stack__note">Merge the stack from its bottom, #{bottom.number}.</p>
      ) : tooLong ? (
        <p className="code-pr-stack__note">
          A stack merges up to {MAX_CODE_PROJECT_PULL_REQUEST_STACK_MERGE} layers in one step.
        </p>
      ) : (
        <OctantButton
          className="code-pr-stack__merge"
          disabled={state.step === "reading" || merging || open !== undefined}
          onClick={() => void review()}
          ref={opener}
          size="sm"
          type="button"
          variant="secondary"
        >
          {state.step === "reading" ? "Reading the stack…" : merging ? "Merging…" : "Merge stack"}
        </OctantButton>
      )}
      {open === undefined ? null : (
        <div
          aria-label="Confirm stack merge"
          className="code-pr-review__merge-confirmation"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !merging) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          role="region"
        >
          {open.status === "blocked" ? (
            <>
              <strong>This stack cannot merge now</strong>
              <p>{open.reason}</p>
            </>
          ) : (
            <>
              <strong>
                Merge {open.layers.length} pull requests into {open.destination}?
              </strong>
              <ol className="code-pr-stack__heads">
                {open.layers.map((layer) => (
                  <li key={layer.number}>
                    #{layer.number} <code>{layer.headSha.slice(0, 7)}</code>
                  </li>
                ))}
              </ol>
              <p>
                They merge bottom first, with {METHOD_WORDS[method]}. Octant points each next layer
                at {open.destination}, and stops at the first that changed since this reading or
                does not merge; those before it stay merged.
              </p>
              {method === "merge" ? null : (
                <p>
                  This method rewrites commits, so a layer that changes the same lines as the one
                  below it can conflict once that one lands. A merge commit avoids that.
                </p>
              )}
            </>
          )}
          <div className="code-pr-review__actions">
            <OctantButton
              disabled={merging}
              onClick={cancel}
              ref={cancelButton}
              size="sm"
              type="button"
              variant="ghost"
            >
              {open.status === "blocked" ? "Close" : "Cancel"}
            </OctantButton>
            {open.status === "blocked" ? null : (
              <OctantButton
                disabled={merging}
                onClick={() => void confirm(open)}
                size="sm"
                type="button"
                variant="destructive"
              >
                Confirm stack merge
              </OctantButton>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
