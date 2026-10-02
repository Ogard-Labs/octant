import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasActor,
  decodeCanvasVersionId,
  type CanvasDefinition,
  type CanvasId,
  type CanvasVersionId,
} from "@octant/contracts/canvas";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import type {
  CanvasReviseRequest,
  CanvasVersionHistoryEntry,
} from "@octant/contracts/canvas-revision";
import type { CanvasCommentCommand, CanvasCommentThread } from "@octant/contracts/canvas-board";
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
import type { WorkspaceTab } from "@octant/contracts/shell";
import { ChevronDown, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantPopover } from "../ui/base/OctantPopover";
import { CanvasCommentsPanel } from "./CanvasCommentsPanel";
import { CanvasSharePanel } from "./CanvasSharePanel";
import {
  CanvasRefreshPanel,
  deriveCanvasRefreshRecipe,
  type CanvasRefreshRequestBase,
} from "./CanvasRefreshPanel";
import { CanvasVersionHistoryPanel, ReviseCanvasDraft } from "./CanvasRevisionPanel";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import { createCanvasActionRuntime } from "./canvasActionRuntime";
import { CanvasView } from "./CanvasView";
import { CanvasVersionCompare } from "./CanvasVersionCompare";
import { CanvasWorkspaceTabActions } from "./CanvasWorkspaceTabActions";

const CANVAS_TOOL_DIALOGS = ["refine", "refresh", "share"] as const;
type CanvasToolDialog = (typeof CANVAS_TOOL_DIALOGS)[number];

export interface CanvasWorkspaceTabProps {
  readonly client: CanvasClient | undefined;
  readonly onAttachContext?: (selection: CanvasContextSelection) => void;
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
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [focusedBlockId, setFocusedBlockId] = useState<string | undefined>(undefined);
  const [commentThreads, setCommentThreads] = useState<ReadonlyArray<CanvasCommentThread>>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [dialog, setDialog] = useState<CanvasToolDialog | undefined>(undefined);
  const [compare, setCompare] = useState<
    | {
        readonly kind: "ready";
        readonly earlier: { readonly sequence: number; readonly definition: CanvasDefinition };
      }
    | { readonly kind: "unavailable" }
    | undefined
  >(undefined);
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
  const commentsReturnFocus = useRef<HTMLElement | null>(null);
  const closeCommentsButton = useRef<HTMLButtonElement | null>(null);

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
    if (commentsOpen) closeCommentsButton.current?.focus();
  }, [commentsOpen, focusedBlockId]);
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

  // A drag is a version of the selected head only: editing an older version
  // would fork history the surface has no way to show, and the server would
  // refuse it as stale anyway. When the host moved on, reload so the user
  // drags the version that exists.
  const layoutRuntime = useMemo<DiagramBoardLayoutRuntime | undefined>(() => {
    const reviseDiagramLayout = props.client?.reviseDiagramLayout;
    if (
      reviseDiagramLayout === undefined ||
      reviseBase === null ||
      selectedVersionId === undefined ||
      String(selectedVersionId) !== tipVersionId
    ) {
      return undefined;
    }
    return {
      onRevise: async (blockId, positions) => {
        const result = await reviseDiagramLayout({
          kind: "canvas-diagram-layout-revise",
          canvasId: props.tab.canvasId,
          versionId: decodeCanvasVersionId(globalThis.crypto.randomUUID()),
          blockId,
          positions,
          actor: LOCAL_PERSON,
          expectedSequence,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          issuedAt: decodeUtcTimestamp(new Date().toISOString()),
        });
        if (result.kind === "accepted") {
          await loadCanvas();
          await loadHistory();
          return { kind: "accepted" };
        }
        if (result.denialCode === "stale-version") {
          await loadCanvas();
          await loadHistory();
          return {
            kind: "denied",
            message:
              "The board changed on the host and was reloaded. Drag again to keep the change.",
          };
        }
        return { kind: "denied", message: result.message };
      },
    };
  }, [
    expectedSequence,
    loadCanvas,
    loadHistory,
    props.client,
    props.tab.canvasId,
    reviseBase,
    selectedVersionId,
    tipVersionId,
  ]);

  // Comments are offered only when the host journals them; the transport's
  // methods are bound once so the panel's effects do not re-run per render.
  const commentsClient = useMemo(() => {
    const comments = props.client?.comments;
    const comment = props.client?.comment;
    if (comments === undefined || comment === undefined) return undefined;
    return {
      load: (canvasId: CanvasId) => comments(canvasId),
      send: (command: CanvasCommentCommand) => comment(command),
    };
  }, [props.client]);

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

  const selectedEntry = history.find(
    (entry) => String(entry.versionId) === String(selectedVersionId),
  );
  const previousEntry =
    selectedEntry === undefined
      ? undefined
      : history
          .filter((entry) => entry.sequence < selectedEntry.sequence)
          .reduce<CanvasVersionHistoryEntry | undefined>(
            (best, entry) => (best === undefined || entry.sequence > best.sequence ? entry : best),
            undefined,
          );
  const commentsAvailable = commentsClient !== undefined && reviseBase !== null;
  const openThreads = commentThreads.filter((thread) => thread.comment.resolvedAt === undefined);
  const openCounts = new Map<string, number>();
  for (const thread of openThreads) {
    const blockId = String(thread.comment.anchor.blockId);
    openCounts.set(blockId, (openCounts.get(blockId) ?? 0) + 1);
  }
  const overflowItems = [
    ...(reviseBase !== null && reviseBase.mode === "chat"
      ? [{ label: "Refine…", value: "refine" }]
      : []),
    ...(refreshRecipe !== undefined && refreshBase !== undefined
      ? [{ label: "Refresh…", value: "refresh" }]
      : []),
    ...(shares !== undefined && selectedVersionId !== undefined
      ? [{ label: "Share…", value: "share" }]
      : []),
  ];

  const openCommentsOn = (blockId: string | undefined) => {
    commentsReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFocusedBlockId(blockId);
    setCommentsOpen(true);
  };
  const closeComments = () => {
    setCommentsOpen(false);
    commentsReturnFocus.current?.focus();
    commentsReturnFocus.current = null;
  };

  const openCompare = async () => {
    setVersionsOpen(false);
    if (props.client === undefined || previousEntry === undefined) return;
    const outcome = await props.client.get(props.tab.canvasId, String(previousEntry.versionId));
    setCompare(
      outcome.kind === "ready"
        ? {
            kind: "ready",
            earlier: {
              sequence: outcome.version.sequence,
              definition: outcome.version.definition,
            },
          }
        : { kind: "unavailable" },
    );
  };

  return (
    <div className="canvas-workspace-tab">
      <header className="canvas-workspace-tab__toolbar">
        <OctantPopover
          align="start"
          className="canvas-workspace-tab__versions"
          onOpenChange={setVersionsOpen}
          open={versionsOpen}
          title="Version history"
          trigger={
            <>
              <span>v{expectedSequence}</span>
              {String(selectedVersionId) === tipVersionId ? null : (
                <span className="canvas-workspace-tab__older">older</span>
              )}
              <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} />
            </>
          }
          triggerLabel={`Version history, v${String(expectedSequence)}`}
          triggerVariant="ghost"
        >
          <CanvasVersionHistoryPanel
            entries={history}
            selectedVersionId={selectedVersionId === undefined ? "" : String(selectedVersionId)}
            currentVersionId={tipVersionId}
            onSelect={(versionId) => {
              setVersionsOpen(false);
              handleSelectVersion(versionId);
            }}
          />
          {previousEntry === undefined ? null : (
            <OctantButton
              onClick={() => void openCompare()}
              size="sm"
              type="button"
              variant="secondary"
            >
              Compare with v{previousEntry.sequence}
            </OctantButton>
          )}
        </OctantPopover>
        <span className="canvas-workspace-tab__spacer" />
        {props.onAttachContext !== undefined && selectedVersionId !== undefined ? (
          <CanvasWorkspaceTabActions
            currentSequence={expectedSequence}
            currentVersionId={selectedVersionId}
            displayName={definition.title}
            onAttachContext={props.onAttachContext}
            {...(props.onPinCanvasInFocusZone === undefined
              ? {}
              : {
                  onPinInFocusZone: () =>
                    props.onPinCanvasInFocusZone?.({
                      canvasId: props.tab.canvasId,
                      title: definition.title,
                    }),
                })}
            tab={props.tab}
          />
        ) : null}
        {commentsAvailable ? (
          <OctantButton
            aria-expanded={commentsOpen}
            aria-label={
              openThreads.length === 0 ? "Comments" : `Comments, ${String(openThreads.length)} open`
            }
            onClick={() => (commentsOpen ? closeComments() : openCommentsOn(undefined))}
            size="sm"
            type="button"
            variant={commentsOpen ? "secondary" : "ghost"}
          >
            <MessageSquare aria-hidden="true" size={14} strokeWidth={1.8} />
            Comments
            {openThreads.length === 0 ? null : (
              <span className="canvas-workspace-tab__count">{openThreads.length}</span>
            )}
          </OctantButton>
        ) : null}
        {overflowItems.length === 0 ? null : (
          <OctantMenu
            items={overflowItems}
            onValueChange={(value) => {
              const chosen = CANVAS_TOOL_DIALOGS.find((candidate) => candidate === value);
              if (chosen !== undefined) setDialog(chosen);
            }}
            selectionMode="action"
            trigger={<MoreHorizontal aria-hidden="true" size={16} strokeWidth={1.8} />}
            triggerClassName="canvas-workspace-tab__overflow"
            triggerLabel="More Canvas actions"
            value=""
          />
        )}
      </header>
      <div className="canvas-workspace-tab__body">
        <CanvasView
          input={definition}
          {...(actionRuntime === undefined ? {} : { actionRuntime })}
          {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
          {...(commentsAvailable ? { comments: { openCounts, onOpen: openCommentsOn } } : {})}
        />
        {commentsClient !== undefined && reviseBase !== null ? (
          <aside
            aria-label="Comments"
            className="canvas-workspace-tab__drawer"
            hidden={!commentsOpen}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeComments();
            }}
          >
            <div className="canvas-workspace-tab__drawer-header">
              <h2>Comments</h2>
              <OctantButton
                aria-label="Close comments"
                onClick={closeComments}
                ref={closeCommentsButton}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" size={14} strokeWidth={1.8} />
              </OctantButton>
            </div>
            <CanvasCommentsPanel
              author={LOCAL_PERSON}
              canvasId={props.tab.canvasId}
              definition={definition}
              load={commentsClient.load}
              onShowAllBlocks={() => setFocusedBlockId(undefined)}
              onThreadsChange={setCommentThreads}
              send={commentsClient.send}
              {...(focusedBlockId === undefined ? {} : { focusedBlockId })}
            />
          </aside>
        ) : null}
      </div>
      <OctantDialog
        label="Refine canvas"
        onClose={() => setDialog(undefined)}
        open={dialog === "refine"}
      >
        {reviseBase !== null && reviseBase.mode === "chat" ? (
          <ReviseCanvasDraft
            expectedSequence={expectedSequence}
            requestBase={reviseBase}
            onRevise={handleRevise}
          />
        ) : null}
      </OctantDialog>
      <OctantDialog
        label="Refresh canvas"
        onClose={() => setDialog(undefined)}
        open={dialog === "refresh"}
      >
        {refreshRecipe !== undefined && refreshBase !== undefined ? (
          <CanvasRefreshPanel
            recipe={refreshRecipe}
            requestBase={refreshBase}
            onRefresh={handleRefresh}
            skillOptions={refreshSkills}
            {...(cancelRefresh === undefined ? {} : { onCancel: handleCancelRefresh })}
          />
        ) : null}
      </OctantDialog>
      <OctantDialog
        className="canvas-workspace-tab__share-dialog"
        label="Share canvas"
        onClose={() => setDialog(undefined)}
        open={dialog === "share"}
      >
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
      </OctantDialog>
      <OctantDialog
        label="Compare versions"
        onClose={() => setCompare(undefined)}
        open={compare !== undefined}
      >
        {compare?.kind === "ready" ? (
          <CanvasVersionCompare
            earlier={compare.earlier}
            later={{ sequence: expectedSequence, definition }}
          />
        ) : compare?.kind === "unavailable" ? (
          <p className="canvas-compare__note">The earlier version is unavailable.</p>
        ) : null}
      </OctantDialog>
    </div>
  );
}

/**
 * Comments and drags are the person's, not the agent that made the Canvas.
 * The host stamps its own local person on both and ignores what is sent; this
 * is that same identity, so the request no longer claims to be the agent, as
 * it did when the creating agent's provenance was copied straight in.
 */
const LOCAL_PERSON = decodeCanvasActor({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000002",
});
