import { OctantEmpty } from "../ui/base/OctantEmpty";
import { CodeLocalReview, type CodeReviewLineSelection } from "../code/CodeLocalReview";
import { CodeTurnReviewTool } from "../code/CodeTurnReviewTool";
import {
  CodeLineNotes,
  type CodeLineNoteAnchor,
  type CodeLineNotesSendResult,
} from "../code/CodeLineNotes";
import type { CodeReviewFileRequest } from "../code/codeReviewNavigation";
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
import { useCodeDiffIgnoreWhitespace } from "../code/codeDiffWhitespacePreference";
import { useCodeFileChangeWatch } from "../code/useCodeFileChangeWatch";
import type { OctantHostBridge } from "./hostBridge";

export interface DockReviewToolProps {
  readonly requestedCodeReviewFile?: CodeReviewFileRequest;
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
  /** Sends a turn's line notes as one ordinary follow-up message in this thread. */
  readonly onSendLineNotes?: (message: string) => Promise<CodeLineNotesSendResult>;
  /** Why line notes cannot be sent right now, such as a turn still running. */
  readonly lineNotesSendUnavailable?: string;
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
    return <OctantEmpty state="loading" title="Loading review" />;
  }
  if (
    props.requestedCodeReviewFile !== undefined &&
    props.requestedCodeReviewFile.checkoutId !== checkoutId
  )
    return (
      <OctantEmpty
        state="warning"
        title="Receipt checkout unavailable"
        message="This receipt belongs to an earlier checkout binding. Open its original checkout to review it; its files cannot be retargeted here."
      />
    );
  if (props.requestedCodeReviewFile?.turnCapture !== undefined)
    return (
      <CodeTurnReviewTool
        client={props.client}
        view={view}
        threadId={props.threadId}
        request={props.requestedCodeReviewFile}
        capture={props.requestedCodeReviewFile.turnCapture}
        {...(props.defaultDiffLayout === undefined
          ? {}
          : { defaultDiffLayout: props.defaultDiffLayout })}
        {...(props.createUuid === undefined ? {} : { createUuid: props.createUuid })}
        {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
        {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
        {...lineNoteProps(props)}
      />
    );
  return (
    <BoundReview
      {...(props.requestedCodeReviewFile === undefined
        ? {}
        : { requestedCodeReviewFile: props.requestedCodeReviewFile })}
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
      {...lineNoteProps(props)}
    />
  );
}

function lineNoteProps(
  props: Pick<DockReviewToolProps, "onSendLineNotes" | "lineNotesSendUnavailable">,
): Pick<DockReviewToolProps, "onSendLineNotes" | "lineNotesSendUnavailable"> {
  return {
    ...(props.onSendLineNotes === undefined ? {} : { onSendLineNotes: props.onSendLineNotes }),
    ...(props.lineNotesSendUnavailable === undefined
      ? {}
      : { lineNotesSendUnavailable: props.lineNotesSendUnavailable }),
  };
}

function BoundReview(props: {
  readonly requestedCodeReviewFile?: CodeReviewFileRequest;
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
  readonly onSendLineNotes?: (message: string) => Promise<CodeLineNotesSendResult>;
  readonly lineNotesSendUnavailable?: string;
}) {
  const nextUuid = useCallback(
    () => props.createUuid?.() ?? globalThis.crypto.randomUUID(),
    [props.createUuid],
  );
  const [line, setLine] = useState<CodeReviewLineSelection>();
  const [noteAnchor, setNoteAnchor] = useState<CodeLineNoteAnchor>();
  const [projection, setProjection] = useState<CodeDiffProjection>({ state: "loading" });
  const [stale, setStale] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useCodeDiffIgnoreWhitespace();
  const scope = useMemo(
    () => ({ checkoutId: props.checkoutId, threadId: props.threadId }),
    [props.checkoutId, props.threadId],
  );

  const observe = useCallback(async () => {
    setLine(undefined);
    setStale(false);
    setProjection({ state: "loading" });
    setProjection(await observeCodeThreadDiff(props.client, nextUuid, scope, { ignoreWhitespace }));
  }, [ignoreWhitespace, nextUuid, props.client, scope]);

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
    <>
      <p>Checkout changes only. Edits in extra Project folders are not included.</p>
      {props.requestedCodeReviewFile === undefined ? null : (
        <p role="note">
          Opened {props.requestedCodeReviewFile.path} from a completed turn in this checkout. This
          is the current captured comparison, not a frozen diff of that turn.
        </p>
      )}
      <CodeDiffPane
        onSelectReviewLine={(selection, text) => {
          setLine(selection);
          // Line notes answer a turn, so they appear only in Review opened from one.
          if (props.requestedCodeReviewFile !== undefined)
            setNoteAnchor({
              path: selection.path,
              side: selection.side,
              line: selection.line,
              text,
            });
        }}
        {...(props.requestedCodeReviewFile === undefined
          ? {}
          : { requestedCodeReviewFile: props.requestedCodeReviewFile })}
        client={refreshingClient}
        createGitOperationId={() => nextUuid() as never}
        createOperationId={() => nextUuid() as never}
        defaultLayout={props.defaultDiffLayout ?? "unified"}
        diff={projection}
        ignoreWhitespace={{
          value: ignoreWhitespace,
          onChange: setIgnoreWhitespace,
        }}
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
      {props.requestedCodeReviewFile === undefined ? null : (
        <CodeLineNotes
          {...(noteAnchor === undefined ? {} : { anchor: noteAnchor })}
          {...(props.onSendLineNotes === undefined ? {} : { onSend: props.onSendLineNotes })}
          {...(props.lineNotesSendUnavailable === undefined
            ? {}
            : { sendUnavailable: props.lineNotesSendUnavailable })}
        />
      )}
      <CodeLocalReview
        client={props.client}
        scope={scope}
        executionPolicy={props.view.thread.executionPolicy}
        {...(line === undefined ? {} : { line })}
        {...(props.createUuid === undefined ? {} : { createUuid: props.createUuid })}
        onRefreshComparison={() => void observe()}
      />
    </>
  );
}
