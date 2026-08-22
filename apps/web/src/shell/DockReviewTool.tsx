import type { CodeFileListingClient } from "@octant/client-runtime";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeDiffPane, type CodeDiffProjection } from "../code/CodeDiffPane";
import type { MonacoDiffRuntime } from "../code/MonacoEditorAdapter";
import { nativeCodeWorkspaceApprovals } from "../code/codeWorkspaceApprovals";
import { useCodeFileChangeWatch } from "../code/useCodeFileChangeWatch";
import type { CodeController } from "../code/useCodeController";
import { ShellState } from "./ShellState";
import type { OctantHostBridge } from "./hostBridge";

type RunReviewed = Extract<CodeOperationResult, { readonly kind: "run-reviewed" }>;

const MAX_DIFF_BYTES = 1024 * 1024;

export interface DockReviewToolProps {
  readonly controller?: CodeController;
  readonly threadId: CodeThreadId;
  readonly checkoutId?: CodeCheckoutId;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenFile?: (relativePath: CodeRelativePath) => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly createUuid?: () => string;
  readonly loadRuntime?: () => Promise<MonacoDiffRuntime>;
  /** Injected in tests; otherwise the checkout watch is built from the host. */
  readonly watchClient?: Pick<CodeFileListingClient, "watch">;
}

/**
 * Local checkout changes — and, when the checkout is clean, the branch diff a
 * finished run produced — beside the thread that owns them.
 *
 * Review never replaces the transcript. A pane switch remounts this tool on
 * the next thread's identity, and the first render after that identity
 * changes is empty-handed until the host answers again.
 */
export function DockReviewTool(props: DockReviewToolProps) {
  const view =
    props.controller?.activeView !== undefined &&
    String(props.controller.activeView.thread.id) === String(props.threadId)
      ? props.controller.activeView
      : undefined;
  const checkoutId = props.checkoutId ?? view?.checkout.id;
  if (props.controller === undefined || view === undefined || checkoutId === undefined) {
    return (
      <ShellState
        message="This Code thread is still loading its Review state."
        state="neutral"
        title="Review is unavailable"
      />
    );
  }
  return (
    <BoundReview
      key={`${String(props.threadId)}:${String(checkoutId)}`}
      checkoutId={checkoutId}
      controller={props.controller}
      threadId={props.threadId}
      view={view}
      {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
      {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
      {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
      {...(props.windowCapability === undefined
        ? {}
        : { windowCapability: props.windowCapability })}
      {...(props.createUuid === undefined ? {} : { createUuid: props.createUuid })}
      {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
      {...(props.watchClient === undefined ? {} : { watchClient: props.watchClient })}
    />
  );
}

function BoundReview(props: {
  readonly checkoutId: CodeCheckoutId;
  readonly controller: CodeController;
  readonly threadId: CodeThreadId;
  readonly view: NonNullable<CodeController["activeView"]>;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenFile?: (relativePath: CodeRelativePath) => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly createUuid?: () => string;
  readonly loadRuntime?: () => Promise<MonacoDiffRuntime>;
  readonly watchClient?: Pick<CodeFileListingClient, "watch">;
}) {
  const nextUuid = useCallback(
    () => props.createUuid?.() ?? globalThis.crypto.randomUUID(),
    [props.createUuid],
  );
  const [projection, setProjection] = useState<CodeDiffProjection>({ state: "loading" });
  const [stale, setStale] = useState(false);
  const scope = useMemo(
    () => ({ checkoutId: props.checkoutId, threadId: props.threadId }),
    [props.checkoutId, props.threadId],
  );

  const observe = useCallback(async () => {
    setStale(false);
    setProjection({ state: "loading" });
    try {
      const checkout = await props.controller.client.executeOperation({
        kind: "observe-git",
        operationId: nextUuid() as never,
        gitOperationId: nextUuid() as never,
        maxDiffBytes: MAX_DIFF_BYTES,
        ...scope,
      });
      if (checkout.kind === "operation-failed") {
        setProjection({ state: "unavailable", message: checkout.failure.message });
        return;
      }
      if (checkout.kind !== "git-observed") {
        setProjection({
          state: "unavailable",
          message: "Git observation returned no authoritative checkout state.",
        });
        return;
      }
      if (checkout.changedPaths.length > 0) {
        setProjection({ state: "available", observation: checkout, ...scope });
        return;
      }
      const run = await readRunReview(props.controller.client, nextUuid, scope);
      if (run !== undefined && run.outcome.changedPaths.length > 0) {
        setProjection({ state: "run", run, ...scope });
        return;
      }
      setProjection({ state: "available", observation: checkout, ...scope });
    } catch {
      setProjection({
        state: "unavailable",
        message: "Git observation is unavailable. Reconnect and retry.",
      });
    }
  }, [nextUuid, props.controller.client, scope]);

  useEffect(() => {
    // Clear the previous subject's files before the next observation lands.
    setStale(false);
    setProjection({ state: "loading" });
    void observe();
  }, [observe]);

  useCodeFileChangeWatch({
    enabled: projection.state === "available" || projection.state === "run",
    threadId: props.threadId,
    checkoutId: props.checkoutId,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    ...(props.watchClient === undefined ? {} : { client: props.watchClient }),
    onChanged: () => setStale(true),
  });

  const refreshingClient = useMemo(
    (): CodeClient => ({
      ...props.controller.client,
      async executeOperation(command) {
        const result = await props.controller.client.executeOperation(command);
        if (result.kind === "git-mutation-state" && result.state === "completed") void observe();
        return result;
      },
    }),
    [observe, props.controller.client],
  );

  const approvals = nativeCodeWorkspaceApprovals(props.hostBridge, props.view);

  return (
    <CodeDiffPane
      client={refreshingClient}
      createGitOperationId={() => nextUuid() as never}
      createOperationId={() => nextUuid() as never}
      diff={projection}
      executionPolicy={props.view.thread.executionPolicy}
      {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
      {...(props.onOpenFile === undefined
        ? {}
        : { onOpenFile: (path) => props.onOpenFile?.(path as CodeRelativePath) })}
      {...(approvals?.git === undefined ? {} : { requestApproval: approvals.git })}
      {...(stale
        ? {
            staleNotice: {
              message: "Git state changed; refresh the diff.",
              onRefresh: () => void observe(),
            },
          }
        : {})}
    />
  );
}

async function readRunReview(
  client: Pick<CodeClient, "executeOperation">,
  nextUuid: () => string,
  scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId },
): Promise<RunReviewed | undefined> {
  try {
    const result = await client.executeOperation({
      kind: "review-run",
      operationId: nextUuid() as never,
      gitOperationId: nextUuid() as never,
      maxDiffBytes: MAX_DIFF_BYTES,
      ...scope,
    });
    return result.kind === "run-reviewed" ? result : undefined;
  } catch {
    return undefined;
  }
}
