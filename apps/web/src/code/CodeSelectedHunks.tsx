import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeApprovalId,
  CodeCheckoutId,
  CodeGitOperationId,
  CodeThreadId,
} from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { MAX_CODE_SELECTED_GIT_HUNKS, type CodeGitHunkUnavailableReason } from "@octant/contracts";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { parseUnifiedDiff } from "./unifiedDiff";
import { UnifiedDiffList } from "./UnifiedDiffList";

type Comparison = Extract<CodeOperationResult, { readonly kind: "git-hunks" }>;
type Command = Parameters<CodeClient["executeOperation"]>[0];
export interface CodeSelectedHunksProps {
  readonly client: Pick<CodeClient, "executeOperation" | "operationContent">;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly createOperationId: () => CodeOperationId;
  readonly createGitOperationId: () => CodeGitOperationId;
  readonly requestApproval?: (command: Command) => Promise<CodeApprovalId | undefined>;
}

const UNAVAILABLE: Readonly<Record<CodeGitHunkUnavailableReason, string>> = {
  binary: "Binary changes have no text hunks. Use whole-file staging.",
  rename: "Renamed files cannot be changed by hunk here. Use the file controls.",
  conflict: "Resolve this conflict before selecting hunks.",
  "mode-change": "File mode or nonregular-file changes require whole-file review.",
  "path-encoding": "Git's path cannot be matched safely. Hunk selection is unavailable.",
  truncated: "This diff is incomplete. No hunks can be selected from it.",
  "invalid-hunk": "Git's hunk could not be validated. Refresh the comparison.",
  "too-many-hunks": "This comparison has too many hunks. Use the file controls.",
  untracked: "Untracked files require whole-file staging.",
};

const WAIT_MS = 30_000;
/** Current checkout only. The host retains canonical patch bytes; the person sends identities. */
export function CodeSelectedHunks(props: CodeSelectedHunksProps) {
  const [view, setView] = useState<{
    readonly owner: CodeSelectedHunksProps["client"];
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly comparison: Comparison;
    readonly text: string;
  }>();
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const serial = useRef(0);
  const live = useRef(props);
  live.current = props;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      serial.current += 1;
    };
  }, []);
  useEffect(() => {
    serial.current += 1;
    setPending(false);
    setConfirming(false);
    setSelected([]);
    setMessage(undefined);
  }, [props.client, props.threadId, props.checkoutId]);
  const shown =
    view?.owner === props.client &&
    view.threadId === props.threadId &&
    view.checkoutId === props.checkoutId
      ? view
      : undefined;
  const ticket = () => {
    const request = ++serial.current;
    const owner = props.client;
    const threadId = props.threadId;
    const checkoutId = props.checkoutId;
    return () =>
      mounted.current &&
      serial.current === request &&
      live.current.client === owner &&
      live.current.threadId === threadId &&
      live.current.checkoutId === checkoutId;
  };
  const wait = async <T,>(request: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "The host did not finish in time. Refresh the comparison before trying again; a requested write may still finish.",
                ),
              ),
            WAIT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const load = async (scope: Comparison["scope"], current: () => boolean) => {
    const result = await wait(
      props.client.executeOperation({
        kind: "prepare-git-hunks",
        threadId: props.threadId,
        checkoutId: props.checkoutId,
        operationId: props.createOperationId(),
        gitOperationId: props.createGitOperationId(),
        scope,
      }),
    );
    if (!current()) return;
    if (result.kind === "operation-failed") throw new Error(result.failure.message);
    if (
      result.kind !== "git-hunks" ||
      result.threadId !== props.threadId ||
      result.checkoutId !== props.checkoutId ||
      result.scope !== scope
    )
      throw new Error("The host did not return this checkout's exact comparison.");
    const content = await wait(
      props.client.operationContent(props.threadId, result.operationId, result.diff.contentId),
    );
    if (!current()) return;
    setView({
      owner: props.client,
      threadId: props.threadId,
      checkoutId: props.checkoutId,
      comparison: result,
      text: new TextDecoder("utf-8", { fatal: true }).decode(content),
    });
    setSelected([]);
  };
  const refresh = async (scope: Comparison["scope"]) => {
    const current = ticket();
    setPending(true);
    setMessage(undefined);
    setView(undefined);
    setSelected([]);
    setConfirming(false);
    try {
      await load(scope, current);
    } catch (error) {
      if (current())
        setMessage(
          error instanceof Error
            ? error.message
            : "Exact hunks are unavailable. Refresh and try again.",
        );
    } finally {
      if (current()) setPending(false);
    }
  };
  const apply = async (action: "stage" | "unstage" | "reverse") => {
    if (shown === undefined || selected.length === 0 || pending || props.executionPolicy === "plan")
      return;
    const current = ticket();
    const scope = shown.comparison.scope;
    const command: Command = {
      kind:
        action === "stage"
          ? "stage-git-hunks"
          : action === "unstage"
            ? "unstage-git-hunks"
            : "reverse-git-hunks",
      operationId: props.createOperationId(),
      gitOperationId: props.createGitOperationId(),
      threadId: props.threadId,
      checkoutId: props.checkoutId,
      comparisonOperationId: shown.comparison.operationId,
      selected,
    };
    setPending(true);
    setMessage(undefined);
    try {
      if (
        decidesCodeEffectsByApproval(props.executionPolicy) &&
        (await wait(props.requestApproval?.(command) ?? Promise.resolve(undefined))) === undefined
      ) {
        if (current()) setMessage("No hunks were changed. Approval was not given.");
        return;
      }
      if (!current()) return;
      const result = await wait(props.client.executeOperation(command));
      if (!current()) return;
      setView(undefined);
      setSelected([]);
      setConfirming(false);
      if (result.kind === "operation-failed") throw new Error(result.failure.message);
      if (result.kind === "git-mutation-state" && result.state === "failed")
        throw new Error(
          "Git did not confirm this write. The checkout may have changed. Refresh before trying again.",
        );
      if (result.kind !== "git-mutation-state" || result.state !== "completed")
        throw new Error(
          result.kind === "git-mutation-state" && result.reason === "hunk-offset"
            ? "The hunk moved. Refresh and select its current position; no relocation was applied."
            : "The selected hunks were not applied. Refresh the checkout before trying again.",
        );
      setMessage(
        `${action === "stage" ? "Staged" : action === "unstage" ? "Unstaged" : "Reversed"} selected hunks. Reading the updated comparison.`,
      );
      await load(scope, current);
    } catch (error) {
      if (current()) {
        setView(undefined);
        setSelected([]);
        setConfirming(false);
        setMessage(
          error instanceof Error
            ? error.message
            : "The write outcome is unavailable. Refresh before trying again.",
        );
      }
    } finally {
      if (current()) setPending(false);
    }
  };
  const files = shown === undefined ? [] : parseUnifiedDiff(shown.text);
  return (
    <details className="code-diff-pane__hunk-selection">
      <summary>Select Git hunks</summary>
      <p>
        Compare the index and working tree separately. Selection uses the exact unified patch,
        including whitespace.
      </p>
      <div className="code-git-pane__actions">
        <OctantButton
          disabled={pending}
          onClick={() => void refresh("unstaged")}
          type="button"
          variant="outline"
        >
          Compare unstaged hunks
        </OctantButton>
        <OctantButton
          disabled={pending}
          onClick={() => void refresh("staged")}
          type="button"
          variant="outline"
        >
          Compare staged hunks
        </OctantButton>
      </div>
      {pending ? <p role="status">Waiting for checkout…</p> : null}
      {message === undefined ? null : <OctantAlert tone="neutral">{message}</OctantAlert>}
      {shown === undefined ? null : (
        <>
          <h2>{shown.comparison.scope === "unstaged" ? "Index → Working tree" : "HEAD → Index"}</h2>
          <p>
            {shown.comparison.scope === "unstaged"
              ? "Stage or reverse selected unstaged hunks. Other staged work is kept."
              : "Unstage selected index hunks. Working files are kept."}
          </p>
          {shown.comparison.unavailable.map((item, index) => (
            <p key={index} role="status">
              {item.path ?? "Comparison"}: {UNAVAILABLE[item.reason]}
            </p>
          ))}
          {shown.comparison.hunks.length === 0 ? (
            <p>No selectable text hunks in this comparison.</p>
          ) : null}
          {shown.comparison.hunks.map((identity) => {
            const file = files.find((item) => item.path === identity.path);
            const hunk = file?.hunks[identity.index];
            if (
              file === undefined ||
              hunk === undefined ||
              hunk.oldStart !== identity.oldStart ||
              hunk.newStart !== identity.newStart ||
              hunk.oldLines !== identity.oldLines ||
              hunk.newLines !== identity.newLines
            )
              return (
                <p key={identity.id}>This hunk cannot be displayed. Refresh the comparison.</p>
              );
            return (
              <section key={identity.id} aria-label={`Hunk ${identity.path} ${identity.newStart}`}>
                <label className="check">
                  <OctantCheckbox
                    disabled={
                      pending ||
                      props.executionPolicy === "plan" ||
                      (!selected.includes(identity.id) &&
                        selected.length >= MAX_CODE_SELECTED_GIT_HUNKS)
                    }
                    checked={selected.includes(identity.id)}
                    onChange={(event) =>
                      setSelected((values) =>
                        event.target.checked
                          ? [...values, identity.id]
                          : values.filter((value) => value !== identity.id),
                      )
                    }
                  />
                  <span>
                    Select {identity.path} −{identity.oldStart},{identity.oldLines} +
                    {identity.newStart},{identity.newLines}
                  </span>
                </label>
                <UnifiedDiffList
                  files={[
                    {
                      ...file,
                      hunks: [hunk],
                      additions: hunk.lines.filter((line) => line.kind === "added").length,
                      deletions: hunk.lines.filter((line) => line.kind === "removed").length,
                    },
                  ]}
                />
              </section>
            );
          })}
          <p>
            {selected.length} selected (up to {MAX_CODE_SELECTED_GIT_HUNKS} at once).
          </p>
          <div className="code-git-pane__actions">
            <OctantButton
              disabled={pending || selected.length === 0 || props.executionPolicy === "plan"}
              onClick={() => void apply(shown.comparison.scope === "staged" ? "unstage" : "stage")}
              type="button"
            >
              {shown.comparison.scope === "staged" ? "Unstage" : "Stage"} selected hunks
            </OctantButton>
            {shown.comparison.scope === "unstaged" ? (
              <OctantButton
                disabled={pending || selected.length === 0 || props.executionPolicy === "plan"}
                onClick={() => setConfirming(true)}
                type="button"
                variant="outline"
              >
                Reverse selected hunks…
              </OctantButton>
            ) : null}
          </div>
          {confirming ? (
            <OctantConfirmDialog
              title="Reverse selected hunks?"
              confirmLabel="Reverse hunks"
              cancelLabel="Keep changes"
              destructive
              pending={pending}
              onCancel={() => setConfirming(false)}
              onConfirm={() => void apply("reverse")}
            >
              Reverse {selected.length} selected unstaged hunks? These uncommitted changes will be
              lost. Other hunks and the index are kept.
            </OctantConfirmDialog>
          ) : null}
        </>
      )}
    </details>
  );
}
