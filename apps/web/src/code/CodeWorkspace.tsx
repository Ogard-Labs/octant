import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkspaceTab } from "@octant/contracts/shell";
import type {
  CodeOperationResult,
  CodePullRequestReview,
  CodeReviewFinding,
} from "@octant/contracts/code-operations";
import type { CodeRepositoryTestDefinition } from "@octant/contracts/code-test-definitions";
import { LoaderCircle } from "lucide-react";
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { CodeGitPane } from "./CodeGitPane";
import type { CodeEditorFileProjection } from "./MonacoEditorPane";
import { CodeOverview, type CodeOverviewSurfaceKind } from "./CodeOverview";
import { CodePullRequestPane } from "./CodePullRequestPane";
import { CodeReviewPane, type CodeReviewTarget } from "./CodeReviewPane";
import type { CodeTerminalPaneProps } from "./CodeTerminalPane";
import { CodeTestPane } from "./CodeTestPane";
import { CodeThreadWorkspace } from "./CodeThreadWorkspace";
import type { CodeController } from "./useCodeController";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";
import type { CodeTerminalId } from "@octant/contracts/code";
import { LOCAL_TOOL_HOST_ID } from "@octant/contracts/tool-actions";
import { AppleWorkbenchPane } from "../apple/AppleWorkbenchPane";
import { useAppleWorkbench } from "../apple/useAppleWorkbench";

const CodeDiffPane = lazy(() =>
  import("./CodeDiffPane").then((module) => ({ default: module.CodeDiffPane })),
);
const MonacoEditorPane = lazy(() =>
  import("./MonacoEditorPane").then((module) => ({ default: module.MonacoEditorPane })),
);
const CodeTerminalPane = lazy(() =>
  import("./CodeTerminalPane").then((module) => ({ default: module.CodeTerminalPane })),
);

type CodeTab = Extract<WorkspaceTab, { readonly mode: "code" }>;
type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;
type TerminalResult = Extract<CodeOperationResult, { readonly kind: "terminal-state" }>;
type TestResult = Extract<CodeOperationResult, { readonly kind: "repository-test-state" }>;

export interface CodeWorkspaceProjections {
  readonly file?: CodeEditorFileProjection;
  readonly findings?: ReadonlyArray<CodeReviewFinding>;
  readonly reviewTarget?: CodeReviewTarget;
  readonly terminal?: TerminalResult;
  readonly tests?: {
    readonly definitions: ReadonlyArray<CodeRepositoryTestDefinition>;
    readonly result?: TestResult;
  };
}

export interface CodeWorkspaceApprovals {
  readonly git?: React.ComponentProps<typeof CodeGitPane>["requestApproval"];
  readonly pullRequest?: React.ComponentProps<typeof CodePullRequestPane>["requestApproval"];
  readonly review?: React.ComponentProps<typeof CodeReviewPane>["requestApproval"];
  readonly terminal?: CodeTerminalPaneProps["requestApproval"];
  readonly test?: React.ComponentProps<typeof CodeTestPane>["requestApproval"];
}

export interface CodeWorkspaceProps {
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly approvals?: CodeWorkspaceApprovals;
  readonly client: CodeClient;
  readonly controller: CodeController;
  readonly createUuid?: () => string;
  readonly projections?: CodeWorkspaceProjections;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenBrowser?: () => void;
  /** Opens one changed repository file as a Code file tab, from the diff. */
  readonly onOpenFile?: (relativePath: string) => void;
  /** Re-opens the file projection so the editor can leave a stale revision. */
  readonly onRequestFileRefresh?: () => void;
  readonly onOpenSurface?: (kind: CodeOverviewSurfaceKind) => void;
  readonly providerGroups?: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly tab: CodeTab;
  readonly canvasClient?: CanvasClient;
  readonly hostId?: HostId;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  /** Reaches the host's `#thread` mention surface from the Code composer. */
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export function CodeWorkspace(props: CodeWorkspaceProps) {
  const nextUuid = useCallback(
    () => props.createUuid?.() ?? globalThis.crypto.randomUUID(),
    [props.createUuid],
  );
  const view =
    props.controller.activeView?.thread.id === props.tab.threadId
      ? props.controller.activeView
      : undefined;

  if (view === undefined) {
    return (
      <CodeOverview
        controller={props.controller}
        {...(props.onOpenSurface === undefined ? {} : { onOpenSurface: props.onOpenSurface })}
        threadId={props.tab.threadId}
      />
    );
  }

  if (props.tab.kind === "code-overview") {
    return (
      <CodeThreadWorkspace
        {...(props.agentRunClient === undefined ? {} : { agentRunClient: props.agentRunClient })}
        {...(props.agentRunSettingsClient === undefined
          ? {}
          : { agentRunSettingsClient: props.agentRunSettingsClient })}
        controller={props.controller}
        {...(props.onOpenBrowser === undefined ? {} : { onOpenBrowser: props.onOpenBrowser })}
        {...(props.onOpenSurface === undefined ? {} : { onOpenSurface: props.onOpenSurface })}
        {...(props.providerGroups === undefined ? {} : { providerGroups: props.providerGroups })}
        {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        {...(props.onOpenCanvas === undefined ? {} : { onOpenCanvas: props.onOpenCanvas })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
        threadId={props.tab.threadId}
      />
    );
  }

  const scope = { checkoutId: view.checkout.id, threadId: view.thread.id } as const;
  switch (props.tab.kind) {
    case "code-file":
      return props.projections?.file?.path === props.tab.relativePath ? (
        <MonacoEditorPane
          client={props.client}
          draftStore={props.controller.editorDrafts}
          file={props.projections.file}
          {...(props.onRequestFileRefresh === undefined
            ? {}
            : { onRequestRefresh: props.onRequestFileRefresh })}
          {...(props.hostBridge?.openCodeExternalEditor === undefined
            ? {}
            : {
                onOpenExternalEditor: () =>
                  props.hostBridge!.openCodeExternalEditor!({
                    threadId: props.projections!.file!.threadId,
                    checkoutId: props.projections!.file!.checkoutId,
                    fileId: props.projections!.file!.fileId,
                    line: 1,
                    column: 1,
                  }),
              })}
        />
      ) : (
        <UnavailableProjection
          message="Reload this tab when the authoritative file projection is available. Your workspace layout remains preserved."
          title={`${props.tab.relativePath} is unavailable`}
        />
      );
    case "code-diff":
    case "code-git":
      return <GitWorkspaceSurface {...props} nextUuid={nextUuid} scope={scope} tab={props.tab} />;
    case "code-terminal":
      return (
        <TerminalWorkspaceSurface
          {...props}
          nextUuid={nextUuid}
          scope={scope}
          terminalId={scope.threadId as unknown as CodeTerminalId}
          {...(props.projections?.terminal === undefined
            ? {}
            : { terminal: props.projections.terminal })}
          checkoutAvailability={view.checkout.availability}
          threadPolicy={view.thread.executionPolicy}
        />
      );
    case "code-test": {
      const tests = props.projections?.tests;
      if (tests === undefined) {
        return (
          <UnavailableProjection
            message="No authoritative repository-test definitions are attached to this restored tab."
            title="Repository tests unavailable"
          />
        );
      }
      if (view.thread.executionPolicy === "approval-gated" && props.approvals?.test === undefined) {
        return <ApprovalUnavailable surface="Repository test" />;
      }
      return (
        <CodeTestPane
          client={props.client}
          createOperationId={() => nextUuid() as never}
          createTestRunId={() => nextUuid() as never}
          definitions={tests.definitions}
          executionPolicy={view.thread.executionPolicy}
          {...(props.approvals?.test === undefined
            ? {}
            : { requestApproval: props.approvals.test })}
          {...(tests.result === undefined ? {} : { result: tests.result })}
          scope={scope}
        />
      );
    }
    case "code-pr":
      return (
        <PullRequestWorkspaceSurface {...props} nextUuid={nextUuid} scope={scope} tab={props.tab} />
      );
    case "code-local-review":
      if (props.projections?.findings === undefined) {
        return (
          <UnavailableProjection
            message="Local findings were not included in the authoritative restored projection."
            title="Local review unavailable"
          />
        );
      }
      if (
        view.thread.executionPolicy === "approval-gated" &&
        props.approvals?.review === undefined
      ) {
        return <ApprovalUnavailable surface="Local review" />;
      }
      return (
        <CodeReviewPane
          client={props.client}
          createFindingId={() => nextUuid() as never}
          createOperationId={() => nextUuid() as never}
          executionPolicy={view.thread.executionPolicy}
          findings={props.projections.findings}
          {...(props.approvals?.review === undefined
            ? {}
            : { requestApproval: props.approvals.review })}
          scope={scope}
          {...(props.projections.reviewTarget === undefined
            ? {}
            : { target: props.projections.reviewTarget })}
        />
      );
    case "apple-workbench":
      if (props.appleToolchainClient === undefined) {
        return (
          <UnavailableProjection
            message="Reconnect to the authoritative Apple toolchain service to restore this workbench."
            title="Apple workbench unavailable"
          />
        );
      }
      return (
        <AppleWorkbenchSurface
          client={props.appleToolchainClient}
          createUuid={nextUuid}
          tab={props.tab}
          thread={view.thread}
          checkoutId={view.checkout.id}
        />
      );
  }
}

function AppleWorkbenchSurface(props: {
  readonly client: AppleToolchainClient;
  readonly createUuid: () => string;
  readonly tab: Extract<CodeTab, { readonly kind: "apple-workbench" }>;
  readonly thread: NonNullable<CodeController["activeView"]>["thread"];
  readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
}) {
  const [identity] = useState(() => ({
    actionId: props.createUuid(),
    correlationId: props.createUuid(),
  }));
  const authority = useMemo(
    () => ({
      hostId: LOCAL_TOOL_HOST_ID,
      mode: "code" as const,
      projectId: props.thread.projectId,
      providerInstanceId: props.thread.providerInstanceId,
      extension: { kind: "core" as const },
    }),
    [props.thread.projectId, props.thread.providerInstanceId],
  );
  const discoveryRequest = useMemo(
    () => ({
      actionId: identity.actionId as never,
      correlationId: identity.correlationId as never,
      authority,
      threadId: props.thread.id,
      checkoutId: props.checkoutId,
      projectPath: props.tab.projectPath,
    }),
    [
      authority,
      identity.actionId,
      identity.correlationId,
      props.checkoutId,
      props.tab.projectPath,
      props.thread.id,
    ],
  );
  const snapshotRequest = useMemo(
    () => ({
      kind: "apple-snapshot-request" as const,
      authority,
      threadId: props.thread.id,
      checkoutId: props.checkoutId,
    }),
    [authority, props.checkoutId, props.thread.id],
  );
  const controller = useAppleWorkbench({
    client: props.client,
    discoveryRequest,
    snapshotRequest,
  });
  return (
    <AppleWorkbenchPane
      status={controller.status}
      {...(controller.discovery === undefined ? {} : { discovery: controller.discovery })}
      {...(controller.runtime === undefined ? {} : { runtime: controller.runtime })}
      {...(controller.errorMessage === undefined ? {} : { errorMessage: controller.errorMessage })}
      onRetry={controller.retry}
    />
  );
}

function GitWorkspaceSurface(
  props: CodeWorkspaceProps & {
    readonly nextUuid: () => string;
    readonly scope: {
      readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
      readonly threadId: NonNullable<CodeController["activeView"]>["thread"]["id"];
    };
    readonly tab: Extract<CodeTab, { readonly kind: "code-diff" | "code-git" }>;
  },
) {
  const [observation, setObservation] = useState<GitObservation>();
  const [failure, setFailure] = useState<string>();
  const observe = useCallback(async () => {
    setFailure(undefined);
    try {
      const result = await props.client.executeOperation({
        kind: "observe-git",
        operationId: props.nextUuid() as never,
        gitOperationId: props.nextUuid() as never,
        maxDiffBytes: 1024 * 1024,
        ...props.scope,
      });
      if (result.kind === "git-observed") setObservation(result);
      else if (result.kind === "operation-failed") setFailure(result.failure.message);
      else setFailure("Git observation returned no authoritative checkout state.");
    } catch {
      setFailure("Git observation is unavailable. Reconnect and retry.");
    }
  }, [props.client, props.nextUuid, props.scope]);

  useEffect(() => void observe(), [observe]);

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

  if (failure !== undefined) {
    return (
      <ShellState
        action={{ label: "Retry Git observation", onClick: () => void observe() }}
        eyebrow="Code workspace"
        message={failure}
        role="alert"
        state="warning"
        title="Git state unavailable"
      />
    );
  }
  if (observation === undefined) {
    return <GitObservationLoading />;
  }
  if (props.tab.kind === "code-diff") {
    return (
      <CodeDiffPane
        client={props.client}
        diff={{ state: "available", observation, ...props.scope }}
        {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
      />
    );
  }
  const policy = props.controller.activeView!.thread.executionPolicy;
  if (policy === "approval-gated" && props.approvals?.git === undefined) {
    return <ApprovalUnavailable surface="Git mutation" />;
  }
  return (
    <CodeGitPane
      client={refreshingClient}
      createGitOperationId={() => props.nextUuid() as never}
      createOperationId={() => props.nextUuid() as never}
      executionPolicy={policy}
      observation={observation}
      {...(props.onOpenSurface === undefined
        ? {}
        : { onReviewPullRequest: () => props.onOpenSurface!("code-pr") })}
      {...(props.approvals?.git === undefined ? {} : { requestApproval: props.approvals.git })}
      scope={props.scope}
    />
  );
}

function PullRequestWorkspaceSurface(
  props: CodeWorkspaceProps & {
    readonly nextUuid: () => string;
    readonly scope: {
      readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
      readonly threadId: NonNullable<CodeController["activeView"]>["thread"]["id"];
    };
    readonly tab: Extract<CodeTab, { readonly kind: "code-pr" }>;
  },
) {
  const [review, setReview] = useState<CodePullRequestReview>();
  const [failure, setFailure] = useState<string>();
  const observe = useCallback(async () => {
    setFailure(undefined);
    try {
      const result = await props.client.executeOperation({
        kind: "observe-pull-request",
        operationId: props.nextUuid() as never,
        maxDiffBytes: 1024 * 1024,
        ...props.scope,
      });
      if (result.kind === "pull-request-review") setReview(result);
      else if (result.kind === "operation-failed") setFailure(result.failure.message);
      else setFailure("Pull request observation returned no authoritative state.");
    } catch {
      setFailure("Pull request observation is unavailable. Reconnect and retry.");
    }
  }, [props.client, props.nextUuid, props.scope]);

  useEffect(() => void observe(), [observe]);

  if (failure !== undefined) {
    return (
      <ShellState
        action={{ label: "Retry pull request observation", onClick: () => void observe() }}
        eyebrow="Code workspace"
        message={failure}
        role="alert"
        state="warning"
        title="Pull request state unavailable"
      />
    );
  }
  if (review === undefined) {
    return <p role="status">Loading linked pull request…</p>;
  }
  const policy = props.controller.activeView!.thread.executionPolicy;
  if (
    review.state !== "observed" &&
    policy === "approval-gated" &&
    props.approvals?.pullRequest === undefined
  ) {
    return <ApprovalUnavailable surface="Pull request" />;
  }
  return (
    <CodePullRequestPane
      client={props.client}
      createOperationId={() => props.nextUuid() as never}
      executionPolicy={policy}
      idempotencyKey={`code-tab:${props.tab.id}`}
      onRefresh={() => void observe()}
      review={review}
      {...(props.onOpenSurface === undefined
        ? {}
        : { onNavigateWorktree: () => props.onOpenSurface!("code-git") })}
      {...(props.approvals?.pullRequest === undefined
        ? {}
        : { requestApproval: props.approvals.pullRequest })}
      scope={props.scope}
    />
  );
}

function GitObservationLoading() {
  return (
    <section className="code-git-loading" role="status">
      <div className="code-git-loading__heading">
        <span className="code-git-loading__icon">
          <LoaderCircle aria-hidden="true" className="shell-state__spinner" size={18} />
        </span>
        <div>
          <span className="code-git-loading__eyebrow">Git workspace</span>
          <h1>Loading Git state</h1>
          <p>Loading exact checkout status and diff evidence.</p>
        </div>
      </div>
      <div aria-hidden="true" className="code-git-loading__rows">
        <span />
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function TerminalWorkspaceSurface(
  props: CodeWorkspaceProps & {
    readonly nextUuid: () => string;
    readonly scope: {
      readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
      readonly threadId: NonNullable<CodeController["activeView"]>["thread"]["id"];
    };
    readonly checkoutAvailability: "available" | "unavailable" | "waiting";
    readonly terminal?: TerminalResult;
    readonly terminalId: CodeTerminalId;
    readonly threadPolicy: "plan" | "approval-gated" | "full-access";
  },
) {
  const terminalRefreshIntervalMs = 500;
  const [terminal, setTerminal] = useState(props.terminal);
  const [failure, setFailure] = useState<string>();
  const [reattaching, setReattaching] = useState(
    props.terminal === undefined && props.checkoutAvailability === "available",
  );
  const [starting, setStarting] = useState(false);
  const startInFlight = useRef(false);
  useEffect(() => {
    if (props.terminal !== undefined) {
      setTerminal(props.terminal);
      setReattaching(false);
      return;
    }
    if (props.checkoutAvailability !== "available") {
      setReattaching(false);
      return;
    }
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setReattaching(true);
    const reattach = async (initial: boolean) => {
      if (startInFlight.current) {
        refreshTimer = setTimeout(() => void reattach(false), terminalRefreshIntervalMs);
        return;
      }
      try {
        const inspection = await props.client.inspectTerminal({
          terminalId: props.terminalId,
          ...props.scope,
        });
        if (!active) return;
        if (
          inspection.terminalId !== props.terminalId ||
          !["running", "exited", "interrupted"].includes(inspection.state)
        ) {
          setFailure("Terminal recovery returned an invalid process identity.");
          return;
        }
        const result = await props.client.executeOperation({
          kind: "attach-terminal",
          operationId: props.nextUuid() as never,
          terminalId: props.terminalId,
          ...props.scope,
        });
        if (!active) return;
        if (result.kind === "terminal-state") {
          setTerminal(result);
          setFailure(undefined);
          return;
        }
        if (result.kind === "operation-failed" && result.failure.category !== "unavailable") {
          setFailure(result.failure.message);
          return;
        }
      } catch (error) {
        if (active && terminalInspectionFailureCategory(error) !== "unavailable") {
          setFailure(
            "Terminal recovery is temporarily unavailable. You can start a fresh terminal.",
          );
          return;
        }
      } finally {
        if (active && initial) setReattaching(false);
      }
      if (active) {
        refreshTimer = setTimeout(() => void reattach(false), terminalRefreshIntervalMs);
      }
    };
    void reattach(true);
    return () => {
      active = false;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [
    props.checkoutAvailability,
    props.client,
    props.nextUuid,
    props.scope.checkoutId,
    props.scope.threadId,
    props.terminal,
    props.terminalId,
  ]);

  if (props.checkoutAvailability === "waiting") {
    return (
      <ShellState
        eyebrow="Code terminal"
        message="Octant is reconnecting the authoritative worktree before repository processes can start."
        state="loading"
        title="Connecting repository checkout"
      />
    );
  }
  if (props.checkoutAvailability === "unavailable") {
    return (
      <ShellState
        eyebrow="Code terminal"
        message="The repository identity changed, so Octant kept this checkout fail-closed. Relink the Project or create a fresh Code thread before starting repository processes."
        state="warning"
        title="Repository checkout changed"
      />
    );
  }
  if (reattaching || starting) {
    return (
      <ShellState
        eyebrow="Code terminal"
        message={
          reattaching
            ? "Octant is reconnecting this tab to its existing repository process."
            : "Octant is requesting the exact checkout authority and attaching one terminal process."
        }
        state="loading"
        title={reattaching ? "Reattaching repository terminal" : "Starting repository terminal"}
      />
    );
  }
  if (terminal !== undefined) {
    return (
      <CodeTerminalPane
        client={props.client}
        createOperationId={() => props.nextUuid() as never}
        executionPolicy={props.threadPolicy}
        {...(props.approvals?.terminal === undefined
          ? {}
          : { requestApproval: props.approvals.terminal })}
        restart={{
          columns: 100,
          createTerminalId: () => props.terminalId,
          credentialRefs: [],
          rows: 30,
        }}
        result={terminal}
        scope={props.scope}
      />
    );
  }
  if (props.threadPolicy === "approval-gated" && props.approvals?.terminal === undefined) {
    return <ApprovalUnavailable surface="Terminal" />;
  }
  const start = async () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setStarting(true);
    const operationId = props.nextUuid() as never;
    const command = {
      kind: "start-terminal",
      operationId,
      terminalId: props.terminalId,
      columns: 100,
      rows: 30,
      credentialRefs: [],
      ...props.scope,
    } as const;
    setFailure(undefined);
    try {
      if (
        props.threadPolicy === "approval-gated" &&
        (await props.approvals?.terminal?.({ command })) !== true
      ) {
        setFailure("Terminal approval was not granted. Review the checkout state and try again.");
        return;
      }
      const result = await props.client.executeOperation(command);
      if (result.kind === "terminal-state") setTerminal(result);
      else if (result.kind === "operation-failed") setFailure(result.failure.message);
    } catch {
      setFailure("Terminal start or approval failed. Reconnect, verify the checkout, and retry.");
    } finally {
      startInFlight.current = false;
      setStarting(false);
    }
  };
  return (
    <ShellState
      {...(props.threadPolicy === "plan"
        ? {}
        : { action: { label: "Start terminal", onClick: () => void start() } })}
      eyebrow="Code terminal"
      message={
        failure ??
        (props.threadPolicy === "plan"
          ? "Plan mode is read-only and cannot start repository processes."
          : "No terminal process is attached. Start one explicitly; Octant never restarts it silently.")
      }
      {...(failure === undefined ? {} : { role: "alert" as const })}
      state={failure === undefined ? "neutral" : "warning"}
      title="No terminal attached"
    />
  );
}

function terminalInspectionFailureCategory(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "category" in error
    ? String(error.category)
    : undefined;
}

function ApprovalUnavailable(props: { readonly surface: string }) {
  return (
    <ShellState
      eyebrow="Approval gated"
      message="This window has no active approval bridge. Octant will not bypass or simulate approval authority."
      state="warning"
      title={`${props.surface} approval unavailable`}
    />
  );
}

function UnavailableProjection(props: { readonly message: string; readonly title: string }) {
  return (
    <ShellState
      eyebrow="Code workspace recovery"
      message={props.message}
      state="warning"
      title={props.title}
    />
  );
}
