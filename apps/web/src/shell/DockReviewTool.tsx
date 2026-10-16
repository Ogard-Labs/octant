import type { CodeFileListingClient } from "@octant/client-runtime";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeBootstrap,
  CodeCheckoutId,
  CodeRelativePath,
  CodeThreadId,
  CodeThreadView,
} from "@octant/contracts/code";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeDiffPane, type CodeDiffProjection } from "../code/CodeDiffPane";
import type { MonacoDiffRuntime } from "../code/MonacoEditorAdapter";
import { nativeCodeWorkspaceApprovals } from "../code/codeWorkspaceApprovals";
import { observeCodeThreadDiff } from "../code/observeCodeThreadDiff";
import { useCodeFileChangeWatch } from "../code/useCodeFileChangeWatch";
import { ShellState } from "./ShellState";
import type { OctantHostBridge } from "./hostBridge";

export interface DockReviewToolProps {
  /** The thread's Code client; without one the tool only says it is loading. */
  readonly client?: CodeClient;
  /** The thread as its own controller last read it. */
  readonly view?: CodeThreadView;
  /** Settings › Code's diff layout, the default while the thread has no stored choice. */
  readonly defaultDiffLayout?: CodeBootstrap["settings"]["defaultDiffLayout"];
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
    props.view !== undefined && String(props.view.thread.id) === String(props.threadId)
      ? props.view
      : undefined;
  const checkoutId = props.checkoutId ?? view?.checkout.id;
  if (props.client === undefined || view === undefined || checkoutId === undefined) {
    return <ShellState state="loading" title="Loading review" />;
  }
  return (
    <BoundReview
      key={`${String(props.threadId)}:${String(checkoutId)}`}
      checkoutId={checkoutId}
      client={props.client}
      {...(props.defaultDiffLayout === undefined
        ? {}
        : { defaultDiffLayout: props.defaultDiffLayout })}
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
  readonly client: CodeClient;
  readonly defaultDiffLayout?: CodeBootstrap["settings"]["defaultDiffLayout"];
  readonly threadId: CodeThreadId;
  readonly view: CodeThreadView;
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
    setProjection(await observeCodeThreadDiff(props.client, nextUuid, scope));
  }, [nextUuid, props.client, scope]);

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
      ...props.client,
      async executeOperation(command) {
        const result = await props.client.executeOperation(command);
        if (result.kind === "git-mutation-state" && result.state === "completed") void observe();
        return result;
      },
    }),
    [observe, props.client],
  );

  const approvals = nativeCodeWorkspaceApprovals(props.hostBridge, props.view);

  return (
    <CodeDiffPane
      client={refreshingClient}
      createGitOperationId={() => nextUuid() as never}
      createOperationId={() => nextUuid() as never}
      defaultLayout={props.defaultDiffLayout ?? "unified"}
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
