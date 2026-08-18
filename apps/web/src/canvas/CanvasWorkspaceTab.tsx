import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasDefinition, CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type {
  CanvasReviseRequest,
  CanvasVersionHistoryEntry,
} from "@octant/contracts/canvas-revision";
import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type {
  CanvasRefreshCancelRequest,
  CanvasRefreshRequest,
  CanvasRefreshResult,
  CanvasRefreshSkillOption,
} from "@octant/contracts/canvas-refresh";
import type {
  CanvasShareAccessRequest,
  CanvasShareOverview,
} from "@octant/contracts/canvas-share-access-log";
import type {
  CanvasShareResult,
  CanvasShareSnapshotRequest,
  CanvasShareSnapshotRevokeRequest,
} from "@octant/contracts/canvas-share-snapshot";
import type { TabGroupId, WorkspaceTab } from "@octant/contracts/shell";
import { ShellState } from "../shell/ShellState";
import { CanvasSharePanel } from "./CanvasSharePanel";
import {
  CanvasRefreshPanel,
  deriveCanvasRefreshRecipe,
  type CanvasRefreshRequestBase,
} from "./CanvasRefreshPanel";
import { CanvasVersionHistoryPanel, ReviseCanvasDraft } from "./CanvasRevisionPanel";
import { createCanvasActionRuntime } from "./canvasActionRuntime";
import { CanvasView } from "./CanvasView";
import { CanvasWorkspaceTabActions } from "./CanvasWorkspaceTabActions";

export interface CanvasWorkspaceTabProps {
  readonly client: CanvasClient | undefined;
  readonly groupId: TabGroupId;
  readonly onAttachContext?: (selection: CanvasContextSelection) => void;
  readonly onTogglePin?: (
    groupId: TabGroupId,
    tab: Extract<WorkspaceTab, { readonly kind: "canvas" }>,
  ) => void;
  readonly tab: Extract<WorkspaceTab, { readonly kind: "canvas" }>;
  readonly onPinCanvasInFocusZone?: (request: {
    readonly canvasId: CanvasId;
    readonly title: string;
  }) => void;
}

export function CanvasWorkspaceTab(props: CanvasWorkspaceTabProps): ReactNode {
  const [definition, setDefinition] = useState<CanvasDefinition | undefined>(undefined);
  const [message, setMessage] = useState("Loading canvas…");
  const [history, setHistory] = useState<ReadonlyArray<CanvasVersionHistoryEntry>>([]);
  const [tipVersionId, setTipVersionId] = useState<string>("");
  const [selectedVersionId, setSelectedVersionId] = useState<CanvasVersionId | undefined>(
    undefined,
  );
  const [expectedSequence, setExpectedSequence] = useState(1);
  const [refreshSkills, setRefreshSkills] = useState<ReadonlyArray<CanvasRefreshSkillOption>>([]);
  const [shares, setShares] = useState<CanvasShareOverview | undefined>(undefined);
  const [reviseBase, setReviseBase] = useState<Omit<
    CanvasReviseRequest,
    "schemaVersion" | "kind" | "requestId" | "expectedSequence" | "prompt"
  > | null>(null);

  // A monotonic token lets the newest load — a version selection, the initial
  // load, or a post-revise/refresh reload — supersede a stale `get` response
  // that resolves later, the same idiom CanvasRefreshPanel uses for its
  // refresh/cancel race. Without it, attach and share could target a version
  // the user no longer has selected.
  const loadToken = useRef(0);

  const loadCanvas = useCallback(
    async (versionId?: string) => {
      if (props.client === undefined) return;
      const current = (loadToken.current += 1);
      const outcome = await props.client.get(
        props.tab.canvasId,
        versionId === undefined ? undefined : versionId,
      );
      if (loadToken.current !== current) return;
      if (outcome.kind === "ready") {
        setDefinition(outcome.version.definition);
        setSelectedVersionId(outcome.version.versionId);
        setExpectedSequence(outcome.version.sequence);
        const provenance = outcome.version.definition.provenance;
        // Only the host knows a Canvas's authoritative workspace scope: a
        // Work root or a Code worktree is durable server state, not
        // something a renderer can derive. Without it the Canvas still reads,
        // but every mutation surface stays closed rather than sending a scope
        // the server would reject.
        if (outcome.workspace === undefined) {
          setReviseBase(null);
          setRefreshSkills([]);
          setMessage("");
          return;
        }
        setRefreshSkills(outcome.refreshSkills ?? []);
        setReviseBase({
          canvasId: props.tab.canvasId,
          hostId: provenance.hostId,
          mode: provenance.mode,
          workspace: outcome.workspace,
          originThreadId: provenance.threadId,
          actor: provenance.actor,
          providerInstanceId: provenance.providerInstanceId,
          modelId: provenance.modelId,
          requestedAuthority: {
            filesystem: false,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: false,
            executionPolicy: "plan",
            permissionPersistence: "current-session",
          },
        });
        setMessage("");
        return;
      }
      setDefinition(undefined);
      setSelectedVersionId(undefined);
      setRefreshSkills([]);
      setMessage(
        outcome.kind === "unavailable"
          ? outcome.reason
          : "Canvas is not authorized in this workspace.",
      );
    },
    [props.client, props.tab.canvasId],
  );

  // Sharing is host-published state: what is shared, who owns it, and whether
  // this host shares at all all come from the server, and every share request
  // is re-checked there. A host without a share surface publishes nothing and
  // the control never appears.
  const loadShares = useCallback(async () => {
    const shareOverview = props.client?.shareOverview;
    if (shareOverview === undefined) return;
    try {
      setShares(await shareOverview(props.tab.canvasId));
    } catch {
      setShares(undefined);
    }
  }, [props.client, props.tab.canvasId]);

  const loadHistory = useCallback(async () => {
    if (props.client === undefined) return;
    const outcome = await props.client.history(props.tab.canvasId);
    if (outcome.kind === "ready") {
      setHistory(outcome.history.entries);
      setTipVersionId(String(outcome.history.currentVersionId));
    }
  }, [props.client, props.tab.canvasId]);

  useEffect(() => {
    let alive = true;
    if (props.client === undefined) {
      // No further load will bump the token here, so retire any in-flight
      // `get` from the previous client explicitly.
      loadToken.current += 1;
      setDefinition(undefined);
      setSelectedVersionId(undefined);
      setMessage("The host canvas client is unavailable.");
      return () => {
        alive = false;
      };
    }
    setDefinition(undefined);
    setSelectedVersionId(undefined);
    setMessage("Loading canvas…");
    setShares(undefined);
    void loadCanvas().then(() => {
      if (!alive) return;
      void loadHistory();
      void loadShares();
    });
    return () => {
      alive = false;
    };
  }, [props.client, props.tab.canvasId, loadCanvas, loadHistory, loadShares]);

  const handleRevise = useCallback(
    async (request: CanvasReviseRequest) => {
      if (props.client === undefined) return false;
      const result = await props.client.revise(request);
      if (result.kind !== "accepted") return false;
      await loadCanvas();
      await loadHistory();
      return true;
    },
    [props.client, loadCanvas, loadHistory],
  );

  // The revise context already carries exactly the provenance a reauthorizable
  // action request needs, so actions reuse it rather than minting a second one.
  // The server re-checks every field before any side effect.
  const actionRuntime = useMemo(() => {
    if (props.client === undefined || reviseBase === null) return undefined;
    return createCanvasActionRuntime(props.client, {
      canvasId: props.tab.canvasId,
      expectedSequence,
      hostId: reviseBase.hostId,
      mode: reviseBase.mode,
      workspace: reviseBase.workspace,
      originThreadId: reviseBase.originThreadId,
      actor: reviseBase.actor,
      providerInstanceId: reviseBase.providerInstanceId,
      modelId: reviseBase.modelId,
      requestedAuthority: reviseBase.requestedAuthority,
    });
  }, [props.client, props.tab.canvasId, reviseBase, expectedSequence]);

  const handleSelectVersion = useCallback(
    (versionId: string) => {
      void loadCanvas(versionId);
    },
    [loadCanvas],
  );

  // Refresh reuses the same reauthorizable context as revise and typed actions;
  // the recipe adds only the canvas's canonical sources. A canvas without
  // sources has no recipe, and a transport without `refresh` offers no control.
  const refreshBase = useMemo<CanvasRefreshRequestBase | undefined>(() => {
    if (reviseBase === null) return undefined;
    return { ...reviseBase, expectedSequence };
  }, [reviseBase, expectedSequence]);

  const refreshRecipe = useMemo(() => {
    if (definition === undefined || refreshBase === undefined) return undefined;
    if (typeof props.client?.refresh !== "function") return undefined;
    return deriveCanvasRefreshRecipe(definition, refreshBase);
  }, [definition, refreshBase, props.client]);

  // A `ready` receipt means a new version was recorded — on the refresh path
  // and equally on the cancel path when the cancellation lost the race — so
  // the tab reloads the canvas and its history rather than showing stale
  // content while claiming otherwise.
  const reloadIfRefreshRecorded = useCallback(
    async (result: CanvasRefreshResult) => {
      if (result.kind === "accepted" && result.receipt.outcome === "ready") {
        await loadCanvas();
        await loadHistory();
      }
    },
    [loadCanvas, loadHistory],
  );

  const handleRefresh = useCallback(
    async (request: CanvasRefreshRequest): Promise<CanvasRefreshResult> => {
      const refresh = props.client?.refresh;
      if (refresh === undefined) {
        return {
          kind: "denied",
          denialCode: "unavailable",
          message: "Canvas refresh is unavailable on this host.",
        };
      }
      const result = await refresh(request);
      await reloadIfRefreshRecorded(result);
      return result;
    },
    [props.client, reloadIfRefreshRecorded],
  );

  const cancelRefresh = props.client?.cancelRefresh;
  const handleCancelRefresh = useCallback(
    async (request: CanvasRefreshCancelRequest): Promise<CanvasRefreshResult> => {
      if (cancelRefresh === undefined) {
        return {
          kind: "denied",
          denialCode: "cancelled",
          message: "Canvas refresh cancellation is unavailable on this host.",
        };
      }
      const result = await cancelRefresh(request);
      await reloadIfRefreshRecorded(result);
      return result;
    },
    [cancelRefresh, reloadIfRefreshRecorded],
  );

  const handleShare = useCallback(
    async (request: CanvasShareSnapshotRequest): Promise<CanvasShareResult> => {
      const share = props.client?.share;
      if (share === undefined) {
        return {
          kind: "denied",
          denialCode: "unavailable",
          message: "Canvas sharing is unavailable on this host.",
        };
      }
      const result = await share(request);
      await loadShares();
      return result;
    },
    [props.client, loadShares],
  );

  const handleRevokeShare = useCallback(
    async (request: CanvasShareSnapshotRevokeRequest): Promise<CanvasShareResult> => {
      const revokeShare = props.client?.revokeShare;
      if (revokeShare === undefined) {
        return {
          kind: "denied",
          denialCode: "unavailable",
          message: "Canvas share revoke is unavailable on this host.",
        };
      }
      const result = await revokeShare(request);
      await loadShares();
      return result;
    },
    [props.client, loadShares],
  );

  const handleOpenShare = useCallback(
    async (request: CanvasShareAccessRequest) => {
      const accessShare = props.client?.accessShare;
      if (accessShare === undefined) {
        return {
          kind: "unavailable" as const,
          denialCode: "unavailable" as const,
          message: "Canvas share access is unavailable on this host.",
        };
      }
      const result = await accessShare(request);
      // The honest outcome is journaled server-side; reload so the owner sees
      // the access they just produced.
      await loadShares();
      return result;
    },
    [props.client, loadShares],
  );

  if (definition === undefined) {
    return (
      <ShellState
        eyebrow="Canvas unavailable"
        message={message}
        state="warning"
        title={props.tab.title}
      />
    );
  }

  return (
    <div className="canvas-workspace-tab">
      {props.onAttachContext !== undefined &&
      props.onTogglePin !== undefined &&
      selectedVersionId !== undefined ? (
        <CanvasWorkspaceTabActions
          currentSequence={expectedSequence}
          currentVersionId={selectedVersionId}
          displayName={definition.title}
          onAttachContext={props.onAttachContext}
          onTogglePin={() => props.onTogglePin?.(props.groupId, props.tab)}
          {...(props.onPinCanvasInFocusZone === undefined
            ? {}
            : {
                onPinInFocusZone: () =>
                  props.onPinCanvasInFocusZone?.({
                    canvasId: props.tab.canvasId,
                    title: definition.title,
                  }),
              })}
          pinned={props.tab.pinned === true}
          tab={props.tab}
        />
      ) : null}
      <div className="canvas-workspace-tab__body">
        <div className="canvas-workspace-tab__main">
          <CanvasView
            input={definition}
            {...(actionRuntime === undefined ? {} : { actionRuntime })}
          />
        </div>
        <aside className="canvas-workspace-tab__sidebar">
          {reviseBase !== null && reviseBase.mode === "chat" ? (
            <ReviseCanvasDraft
              expectedSequence={expectedSequence}
              requestBase={reviseBase}
              onRevise={handleRevise}
            />
          ) : null}
          {refreshRecipe !== undefined && refreshBase !== undefined ? (
            <CanvasRefreshPanel
              recipe={refreshRecipe}
              requestBase={refreshBase}
              onRefresh={handleRefresh}
              skillOptions={refreshSkills}
              {...(cancelRefresh === undefined ? {} : { onCancel: handleCancelRefresh })}
            />
          ) : null}
          {shares !== undefined && selectedVersionId !== undefined ? (
            <CanvasSharePanel
              canvasId={props.tab.canvasId}
              expectedSequence={expectedSequence}
              onOpen={handleOpenShare}
              onRevoke={handleRevokeShare}
              onShare={handleShare}
              overview={shares}
              versionId={selectedVersionId}
            />
          ) : null}
          <CanvasVersionHistoryPanel
            entries={history}
            selectedVersionId={selectedVersionId === undefined ? "" : String(selectedVersionId)}
            currentVersionId={tipVersionId}
            onSelect={handleSelectVersion}
          />
        </aside>
      </div>
    </div>
  );
}
