import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CanvasDesignSystemPanel } from "./CanvasDesignSystemPanel";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ProjectId } from "@octant/contracts";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasActor,
  decodeCanvasBlockId,
  decodeCanvasPlanTaskId,
  decodeCanvasVersionId,
  type CanvasDefinition,
  type CanvasPlanTask,
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
import { ChevronDown, Globe, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { CanvasCommentsPanel, canvasCommentAnchorChoices } from "./CanvasCommentsPanel";
import { CanvasToolRail } from "./CanvasToolRail";
import { CanvasToolSurface } from "./CanvasToolSurface";
import {
  canvasMarkOfAnchor,
  type CanvasCommentMark,
  type CanvasCommentPick,
  type CanvasTool,
} from "./canvasTools";
import type { CanvasBlockMark } from "./CanvasDocument";
import type { ThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import {
  canvasCommentAgentPrompt,
  canvasCommentAttemptKey,
  enqueueCanvasCommentTurn,
} from "./canvasCommentAgentTurn";
import type {
  CanvasExportOfferList,
  CanvasExportPrepareRequest,
  CanvasExportPrepareResult,
} from "@octant/contracts/canvas-export";
import { CanvasExportPanel } from "./CanvasExportPanel";
import { useCanvasExportFolder } from "./useCanvasExportFolder";
import { CanvasPublicLinksSection } from "./CanvasPublicLinksSection";
import { CanvasSharePanel } from "./CanvasSharePanel";
import {
  CanvasRefreshPanel,
  deriveCanvasRefreshRecipe,
  type CanvasRefreshRequestBase,
} from "./CanvasRefreshPanel";
import { CanvasVersionHistoryPanel, ReviseCanvasDraft } from "./CanvasRevisionPanel";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import {
  readWorkspaceFrameTheme,
  withWorkspaceFrameTheme,
  type DesignAssetRuntime,
} from "./blocks/designDocument";
import { copyCanvasHtml, saveCanvasHtmlFile } from "./canvasHtmlFile";
import { designRunRuntimeFor } from "./blocks/designRunningFrame";
import { CanvasNetworkPanel } from "./CanvasNetworkPanel";
import { useCanvasNetworkAccess } from "./useCanvasNetworkAccess";
import type { PlanTaskRuntime } from "./blocks/PlanBlock";
import type { CanvasChoiceRuntime } from "./blocks/ChoiceBlock";
import { canvasChoiceMessage } from "./canvasChoiceMessage";
import { createCanvasActionRuntime } from "./canvasActionRuntime";
import { CanvasView } from "./CanvasView";
import { CanvasVersionCompare } from "./CanvasVersionCompare";
import { CanvasWorkspaceTabActions } from "./CanvasWorkspaceTabActions";

const CANVAS_TOOL_DIALOGS = [
  "refine",
  "refresh",
  "share",
  "export",
  "design-system",
  "network",
] as const;
const CHOICE_MODE_NAMES = { chat: "Chat", work: "Work", code: "Code" } as const;
type CanvasToolDialog = (typeof CANVAS_TOOL_DIALOGS)[number];

export interface CanvasWorkspaceTabProps {
  readonly client: CanvasClient | undefined;
  readonly onAttachContext?: (selection: CanvasContextSelection) => void;
  /**
   * The message queue of the Canvas's owning thread. Without it no comment
   * offers Send to agent; with it the turn still runs under the thread's own
   * authority, and the host refuses it when the person cannot reach the thread.
   */
  readonly queueClient?: ThreadMessageQueueClient;
  readonly tab: Extract<WorkspaceTab, { readonly kind: "canvas" }>;
  readonly onPinCanvasInFocusZone?: (request: {
    readonly canvasId: CanvasId;
    readonly title: string;
  }) => void;
  /**
   * Opens a new-thread draft in the Canvas's own Project with a plan task
   * written into it. The person still sends it; nothing is created here.
   */
  readonly onStartPlanTask?: (request: {
    readonly mode: "work" | "code";
    readonly projectId: ProjectId;
    readonly prompt: string;
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
  const [exportOffers, setExportOffers] = useState<CanvasExportOfferList | undefined>(undefined);
  // Where this Canvas exports to. The host owns the folder; the panel shows it
  // and sends back a candidate the host listed.
  const exportFolder = useCanvasExportFolder({
    client: props.client,
    canvasId: props.tab.canvasId,
  });
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [focusedBlockId, setFocusedBlockId] = useState<string | undefined>(undefined);
  const [focusedRowId, setFocusedRowId] = useState<string | undefined>(undefined);
  const [focusedPart, setFocusedPart] = useState<
    { readonly kind: "node" | "edge"; readonly id: string } | undefined
  >(undefined);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [draftMark, setDraftMark] = useState<CanvasCommentMark | undefined>(undefined);
  const [commentThreads, setCommentThreads] = useState<ReadonlyArray<CanvasCommentThread>>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [dialog, setDialog] = useState<CanvasToolDialog | undefined>(undefined);
  // Update on a public link opens Export on that destination; the menu opens it
  // on whichever destination is first ready. The revision re-reads the links
  // each time the Share dialog opens, so an export made meanwhile shows up.
  const [exportTargetId, setExportTargetId] = useState<string | undefined>(undefined);
  const [publicLinksRevision, setPublicLinksRevision] = useState(0);
  useEffect(() => {
    if (dialog === "share") setPublicLinksRevision((value) => value + 1);
  }, [dialog]);
  const [compare, setCompare] = useState<
    | {
        readonly kind: "ready";
        readonly earlier: { readonly sequence: number; readonly definition: CanvasDefinition };
        readonly later: { readonly sequence: number; readonly definition: CanvasDefinition };
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
  // True while the newest load is in flight. Compare names a pair from the
  // version on screen, and a selection still loading is about to replace it:
  // clicking Compare within a second of picking a version compared the
  // earlier pick's neighbour against the version that then arrived.
  const [loading, setLoading] = useState(false);
  const commentsReturnFocus = useRef<HTMLElement | null>(null);
  // The identities of choice sends the host has not confirmed yet, by answer. A
  // retry of the same answer reuses its identity, so the queue recognises the
  // duplicate, whatever was sent from other choices meanwhile; any other send,
  // including the same answer after the tab reopens, takes a fresh one, since
  // the queue keeps identities it has seen and would refuse a reused one.
  const unconfirmedChoiceSends = useRef(new Map<string, string>());
  const closeCommentsButton = useRef<HTMLButtonElement | null>(null);

  const loadCanvas = useCallback(
    async (versionId?: string) => {
      if (props.client === undefined) return;
      const current = (loadToken.current += 1);
      setLoading(true);
      let outcome: Awaited<ReturnType<CanvasClient["get"]>>;
      try {
        outcome = await props.client.get(
          props.tab.canvasId,
          versionId === undefined ? undefined : versionId,
        );
      } catch (error) {
        // A failed fetch leaves the Canvas on screen as it was, so Compare
        // must not stay held for a version that will never arrive.
        if (loadToken.current === current) setLoading(false);
        throw error;
      }
      if (loadToken.current !== current) return;
      setLoading(false);
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

  const loadExportOffers = useCallback(async () => {
    const exportOffersLoader = props.client?.exportOffers;
    if (exportOffersLoader === undefined) return;
    try {
      setExportOffers(await exportOffersLoader(props.tab.canvasId));
    } catch {
      setExportOffers(undefined);
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
  }, [commentsOpen, focusedBlockId, focusedRowId]);
  useEffect(() => {
    let alive = true;
    if (props.client === undefined) {
      // No further load will bump the token here, so retire any in-flight
      // `get` from the previous client explicitly.
      loadToken.current += 1;
      setLoading(false);
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
    setExportOffers(undefined);
    void loadCanvas().then(() => {
      if (!alive) return;
      void loadHistory();
      void loadShares();
      void loadExportOffers();
    });
    return () => {
      alive = false;
    };
  }, [props.client, props.tab.canvasId, loadCanvas, loadHistory, loadShares, loadExportOffers]);

  const handleRevise = useCallback(
    async (request: CanvasReviseRequest) => {
      if (props.client?.revise === undefined) return false;
      const result = await props.client.revise(request);
      if (result.kind !== "accepted") return false;
      await loadCanvas();
      await loadHistory();
      await loadExportOffers();
      return true;
    },
    [props.client, loadCanvas, loadExportOffers, loadHistory],
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
          await loadExportOffers();
          return { kind: "accepted" };
        }
        if (result.denialCode === "stale-version") {
          await loadCanvas();
          await loadHistory();
          await loadExportOffers();
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
    loadExportOffers,
    loadHistory,
    props.client,
    props.tab.canvasId,
    reviseBase,
    selectedVersionId,
    tipVersionId,
  ]);

  // A design's images are resolved by the host for the version on screen,
  // each time it is drawn, under that version's own thread authority.
  const designAssetRuntime = useMemo<DesignAssetRuntime | undefined>(() => {
    const designAssets = props.client?.designAssets;
    if (designAssets === undefined || selectedVersionId === undefined) return undefined;
    const canvasId = props.tab.canvasId;
    const versionId = String(selectedVersionId);
    return {
      resolve: async (blockId) => {
        const outcome = await designAssets({ canvasId, versionId, blockId });
        return outcome.kind === "ready" ? outcome.assets : undefined;
      },
    };
  }, [props.client, props.tab.canvasId, selectedVersionId]);

  // A Canvas's "Allow network" switch matters only to a prototype. It is the
  // same switch in a browser on the host's machine and in the desktop app,
  // whose main process relays a page's requests to the host's proxy. The host
  // refuses the read to a client it gives no switch.
  const network = useCanvasNetworkAccess({
    client: props.client,
    canvasId: props.tab.canvasId,
    offered:
      definition?.blocks.some((block) => block.kind === "design" && block.runsScript === true) ===
      true,
  });
  // The sidebar is where a person goes to use a Canvas, so a prototype here
  // runs as soon as it is shown, for the version on screen.
  const designRunRuntime = useMemo(
    () =>
      selectedVersionId === undefined
        ? undefined
        : designRunRuntimeFor(props.client, {
            canvasId: props.tab.canvasId,
            versionId: String(selectedVersionId),
            runsOnOpen: true,
            networkOn: network.allowed === true,
          }),
    [props.client, props.tab.canvasId, selectedVersionId, network.allowed],
  );

  // A plan task's status is a version of the selected head only, for the same
  // reasons as a drag: the host refuses an older version as stale.
  const planRuntime = useMemo<PlanTaskRuntime | undefined>(() => {
    const revisePlanTask = props.client?.revisePlanTask;
    const editable =
      revisePlanTask !== undefined &&
      reviseBase !== null &&
      selectedVersionId !== undefined &&
      String(selectedVersionId) === tipVersionId;
    // A task starts as Work or Code in the Canvas's own Project. A Chat
    // Project has no folder to bind, so a Chat Canvas offers no start.
    const startMode =
      props.tab.mode === "work" || props.tab.mode === "code" ? props.tab.mode : undefined;
    const startProjectId = props.tab.projectId;
    const onStartPlanTask = props.onStartPlanTask;
    const start: Pick<PlanTaskRuntime, "onStartTask"> =
      onStartPlanTask === undefined || startMode === undefined || startProjectId === null
        ? {}
        : {
            onStartTask: (planTitle, task) =>
              onStartPlanTask({
                mode: startMode,
                projectId: startProjectId,
                prompt: planTaskPrompt(planTitle, task),
              }),
          };
    if (!editable) return start.onStartTask === undefined ? undefined : start;
    return {
      ...start,
      onSetStatus: async (blockId, taskId, status) => {
        const result = await revisePlanTask({
          kind: "canvas-plan-task-revise",
          canvasId: props.tab.canvasId,
          versionId: decodeCanvasVersionId(globalThis.crypto.randomUUID()),
          blockId: decodeCanvasBlockId(blockId),
          taskId: decodeCanvasPlanTaskId(taskId),
          status,
          actor: LOCAL_PERSON,
          expectedSequence,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          issuedAt: decodeUtcTimestamp(new Date().toISOString()),
        });
        await loadCanvas();
        await loadHistory();
        await loadExportOffers();
        if (result.kind === "accepted") return { kind: "accepted" };
        return {
          kind: "denied",
          message:
            result.denialCode === "stale-version"
              ? "The plan changed on the host and was reloaded. Set the status again to keep it."
              : result.message,
        };
      },
    };
  }, [
    expectedSequence,
    loadCanvas,
    loadExportOffers,
    loadHistory,
    props.client,
    props.onStartPlanTask,
    props.tab.canvasId,
    props.tab.mode,
    props.tab.projectId,
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
        await loadExportOffers();
      }
    },
    [loadCanvas, loadExportOffers, loadHistory],
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

  // An exported file has no Octant page to read the theme from, so an HTML
  // export of a Canvas that holds a design carries the tokens this window
  // draws it with. The host bounds them and writes only a frame's own tokens.
  const holdsDesign = definition?.blocks.some((block) => block.kind === "design") === true;
  const prepareExport = props.client?.prepareExport;
  const prepareExportInTheme = useCallback(
    (request: CanvasExportPrepareRequest): Promise<CanvasExportPrepareResult> => {
      if (prepareExport === undefined) {
        return Promise.reject(new Error("Canvas export is unavailable on this host."));
      }
      return prepareExport(holdsDesign ? withWorkspaceFrameTheme(request) : request);
    },
    [holdsDesign, prepareExport],
  );

  // Save and Copy take one self-contained HTML file of the version on screen.
  // The file reaches only this window, so it names no destination and needs
  // no card; like an HTML export it carries the theme designs are drawn in.
  const htmlFile = props.client?.htmlFile;
  const [htmlFileMessage, setHtmlFileMessage] = useState<string | undefined>(undefined);
  const [htmlFileBusy, setHtmlFileBusy] = useState(false);
  const takeHtmlFile = useCallback(
    async (action: "save-html" | "copy-html" | "save-tsx") => {
      if (htmlFile === undefined || selectedVersionId === undefined) return;
      setHtmlFileBusy(true);
      setHtmlFileMessage(undefined);
      const request = {
        schemaVersion: 1 as const,
        kind: "canvas-html-file" as const,
        canvasId: props.tab.canvasId,
        versionId: selectedVersionId,
        ...(action === "save-tsx" ? { form: "mockups-tsx" as const } : {}),
        ...(action !== "save-tsx" && holdsDesign
          ? { frameTheme: readWorkspaceFrameTheme(document.documentElement) }
          : {}),
      };
      setHtmlFileMessage(
        action === "copy-html"
          ? await copyCanvasHtml(htmlFile, request)
          : await saveCanvasHtmlFile(htmlFile, request),
      );
      setHtmlFileBusy(false);
    },
    [holdsDesign, htmlFile, props.tab.canvasId, selectedVersionId],
  );

  // One click: the host derives a deck from the version on screen and
  // journals it. Like a drag, it targets the head only; on stale the surface
  // reloads, and on nothing-to-present the person learns why.
  const proposeDeck = useCallback(async () => {
    const deckPropose = props.client?.proposeDeck;
    if (deckPropose === undefined || selectedVersionId === undefined) return;
    setHtmlFileBusy(true);
    setHtmlFileMessage(undefined);
    // A failed request or reload still frees the menu and says so; the busy
    // flag never outlives the attempt.
    try {
      const result = await deckPropose({
        kind: "canvas-deck-propose",
        canvasId: props.tab.canvasId,
        versionId: decodeCanvasVersionId(globalThis.crypto.randomUUID()),
        actor: LOCAL_PERSON,
        expectedSequence,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: decodeUtcTimestamp(new Date().toISOString()),
      });
      if (result.kind === "accepted") {
        await loadCanvas();
        await loadHistory();
        await loadExportOffers();
        setHtmlFileMessage("A deck was added from this Canvas's screens and numbers.");
      } else {
        setHtmlFileMessage(result.message);
        if (result.denialCode === "stale-version") {
          await loadCanvas();
          await loadHistory();
          await loadExportOffers();
        }
      }
    } catch {
      setHtmlFileMessage("The deck could not be proposed. Try again.");
    } finally {
      setHtmlFileBusy(false);
    }
  }, [
    expectedSequence,
    loadCanvas,
    loadExportOffers,
    loadHistory,
    props.client,
    props.tab.canvasId,
    selectedVersionId,
  ]);

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

  // The host snapshots only the head version and refuses any other as a scope
  // mismatch, which the share panel could only report as "a different
  // workspace". Until a picked version and the history naming the head have
  // both loaded, which version Share would send is not settled.
  const versionSettled = !loading && tipVersionId !== "";
  const sharingHead = versionSettled && String(selectedVersionId) === tipVersionId;
  // A Share dialog opened while a picked older version was still loading would
  // otherwise stay open on that version once it arrived.
  useEffect(() => {
    if (dialog === "share" && shares !== undefined && versionSettled && !sharingHead)
      setDialog(undefined);
  }, [dialog, shares, versionSettled, sharingHead]);

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
  // The agent works on the head, so a request made from an older version on
  // screen could name blocks the head no longer has.
  const headSequence = history.reduce((head, entry) => Math.max(head, entry.sequence), 0);
  const queueClient = props.queueClient;
  const onSendToAgent =
    queueClient === undefined ||
    reviseBase === null ||
    selectedVersionId === undefined ||
    expectedSequence < headSequence
      ? undefined
      : async (thread: CanvasCommentThread, anchorLabel: string) => {
          const sent = await enqueueCanvasCommentTurn(queueClient, {
            mode: reviseBase.mode,
            threadId: String(reviseBase.originThreadId),
            prompt: canvasCommentAgentPrompt({
              definition,
              canvasId: String(props.tab.canvasId),
              sequence: expectedSequence,
              thread,
              anchorLabel,
            }),
            attemptKey: canvasCommentAttemptKey(thread.comment),
            canvasSelection: {
              canvasId: props.tab.canvasId,
              versionId: selectedVersionId,
              sequence: expectedSequence,
              displayName: definition.title,
              scope: "whole-canvas",
            },
          });
          return sent.status === "sent"
            ? ({ status: "sent", canvasSequence: expectedSequence } as const)
            : sent;
        };
  // A choice is answered from the head, in the Canvas's own thread, as the
  // person's ordinary message: the same queue a composer send uses, so it runs
  // now on an idle thread or waits behind a running turn, under that thread's
  // own authority. Where the window holds no queue or the host gave no scope
  // for the Canvas, its thread cannot be reached from here, and the choice
  // says so instead of offering a send the host would refuse.
  const choiceRuntime: CanvasChoiceRuntime =
    queueClient === undefined
      ? { kind: "read-only", reason: "This window cannot send to this Canvas's thread." }
      : reviseBase === null || selectedVersionId === undefined
        ? { kind: "read-only", reason: "This Canvas's thread cannot be reached from here." }
        : String(selectedVersionId) !== tipVersionId || expectedSequence < headSequence
          ? {
              kind: "read-only",
              reason: "An older version is on screen; answer on the current one.",
            }
          : {
              kind: "can-send",
              threadLabel: `the ${CHOICE_MODE_NAMES[reviseBase.mode]} thread`,
              onSend: async (block, response) => {
                const answer = [
                  String(props.tab.canvasId),
                  String(block.blockId),
                  JSON.stringify(response),
                ].join(":");
                const id = unconfirmedChoiceSends.current.get(answer) ?? crypto.randomUUID();
                unconfirmedChoiceSends.current.set(answer, id);
                const attemptKey = `${answer}:${id}`;
                const sent = await enqueueCanvasCommentTurn(queueClient, {
                  mode: reviseBase.mode,
                  threadId: String(reviseBase.originThreadId),
                  prompt: canvasChoiceMessage({
                    canvasTitle: definition.title,
                    canvasId: String(props.tab.canvasId),
                    block,
                    response,
                  }),
                  attemptKey,
                  canvasSelection: {
                    canvasId: props.tab.canvasId,
                    versionId: selectedVersionId,
                    sequence: expectedSequence,
                    displayName: definition.title,
                    scope: "whole-canvas",
                  },
                });
                if (sent.status === "sent") unconfirmedChoiceSends.current.delete(answer);
                return sent;
              },
            };
  // Refine and Refresh write the next version on top of the head, and the host
  // refuses either from an older version as stale. Comments anchor to blocks of
  // the Canvas rather than to a version, so the host takes them from any
  // version and the drawer stays open to them.
  const viewingOlderVersion = String(selectedVersionId) !== tipVersionId;
  const openThreads = commentThreads.filter((thread) => thread.comment.resolvedAt === undefined);
  const openCounts = new Map<string, number>();
  const openRowCounts = new Map<string, Map<string, number>>();
  const openNodeCounts = new Map<string, Map<string, number>>();
  const marks = new Map<string, ReadonlyArray<CanvasBlockMark>>();
  for (const thread of openThreads) {
    const anchor = thread.comment.anchor;
    const blockId = String(anchor.blockId);
    openCounts.set(blockId, (openCounts.get(blockId) ?? 0) + 1);
    if (anchor.kind === "row") {
      const rows = openRowCounts.get(blockId) ?? new Map<string, number>();
      rows.set(String(anchor.rowId), (rows.get(String(anchor.rowId)) ?? 0) + 1);
      openRowCounts.set(blockId, rows);
    }
    if (anchor.kind === "node") {
      const nodes = openNodeCounts.get(blockId) ?? new Map<string, number>();
      nodes.set(String(anchor.nodeId), (nodes.get(String(anchor.nodeId)) ?? 0) + 1);
      openNodeCounts.set(blockId, nodes);
    }
    const mark = canvasMarkOfAnchor(anchor);
    if (mark !== undefined) {
      marks.set(blockId, [
        ...(marks.get(blockId) ?? []),
        {
          key: String(thread.comment.commentId),
          mark,
          // A note's words are drawn where it is pinned.
          ...(mark.kind === "note" ? { text: thread.comment.body } : {}),
        },
      ]);
    }
  }
  if (draftMark !== undefined) {
    marks.set(draftMark.blockId, [
      ...(marks.get(draftMark.blockId) ?? []),
      { key: "draft", mark: draftMark, draft: true },
    ]);
  }
  const overflowItems = [
    ...(props.client?.revise !== undefined && reviseBase !== null && reviseBase.mode === "chat"
      ? [
          {
            label: "Refine…",
            value: "refine",
            ...(viewingOlderVersion
              ? { disabled: true, description: "Older versions can't be refined." }
              : {}),
          },
        ]
      : []),
    ...(refreshRecipe !== undefined && refreshBase !== undefined
      ? [
          {
            label: "Refresh…",
            value: "refresh",
            ...(viewingOlderVersion
              ? { disabled: true, description: "Older versions can't be refreshed." }
              : {}),
          },
        ]
      : []),
    ...((shares !== undefined || props.client?.publicShares !== undefined) &&
    selectedVersionId !== undefined
      ? [
          {
            label: "Share…",
            value: "share",
            ...(shares === undefined || sharingHead
              ? {}
              : {
                  disabled: true,
                  description: versionSettled
                    ? "Older versions can't be shared."
                    : "Loading this version…",
                }),
          },
        ]
      : []),
    // A switch is a version of the head, like a drag; an older version on
    // screen offers none.
    ...(props.client?.applyDesignSystem === undefined ||
    definition === undefined ||
    definition.provenance.projectId === null ||
    selectedVersionId === undefined ||
    String(selectedVersionId) !== tipVersionId
      ? []
      : [{ label: "Design system…", value: "design-system" }]),
    ...(exportOffers !== undefined &&
    selectedVersionId !== undefined &&
    String(selectedVersionId) === String(exportOffers.versionId)
      ? [
          {
            label: "Export…",
            value: "export",
            ...(exportOffers.targets.length === 0
              ? {
                  disabled: true,
                  description: "No export destination is installed yet.",
                }
              : {}),
          },
        ]
      : []),
    // Shown only when the host answered that this Canvas has a switch here.
    ...(network.allowed === undefined ? [] : [{ label: "Allow network…", value: "network" }]),
    // One file of the version on screen, to this device only. A Canvas with
    // mockups also offers their TSX handoff: the same one-file flow, as
    // dependency-free components.
    ...(htmlFile !== undefined && selectedVersionId !== undefined
      ? [
          ...(["save-html", "copy-html"] as const).map((value) => ({
            label: value === "save-html" ? "Save as HTML file" : "Copy HTML",
            value,
            ...(htmlFileBusy || !versionSettled
              ? {
                  disabled: true,
                  description: htmlFileBusy ? "Making the HTML file…" : "Loading this version…",
                }
              : {}),
          })),
          ...(definition?.blocks.some((block) => block.kind === "mockup") !== true
            ? []
            : [
                {
                  label: "Save mockups as TSX",
                  value: "save-tsx" as const,
                  ...(htmlFileBusy || !versionSettled
                    ? {
                        disabled: true,
                        description: htmlFileBusy ? "Making the file…" : "Loading this version…",
                      }
                    : {}),
                },
              ]),
          ...(props.client?.proposeDeck === undefined ||
          selectedVersionId === undefined ||
          !versionSettled ||
          definition?.blocks.some((block) => block.kind === "deck") === true
            ? []
            : [
                {
                  label: "Propose a deck",
                  value: "propose-deck" as const,
                  ...(htmlFileBusy ? { disabled: true, description: "Making the deck…" } : {}),
                },
              ]),
        ]
      : []),
  ];

  const openCommentsOn = (blockId: string | undefined, rowId?: string) => {
    // A tool's pick moves no focus, so with the drawer already open focus is
    // still inside it. The drawer is hidden on close and cannot take focus
    // back; the place remembered when it opened stays the one to return to.
    const active = document.activeElement;
    const inDrawer = active?.closest(".canvas-workspace-tab__drawer") ?? null;
    if (inDrawer === null) {
      commentsReturnFocus.current = active instanceof HTMLElement ? active : null;
    }
    setFocusedBlockId(blockId);
    setFocusedRowId(rowId);
    setFocusedPart(undefined);
    setDraftMark(undefined);
    setCommentsOpen(true);
  };
  // The Comment tool: the drawer opens on the part the person pointed at.
  const openCommentsOnPick = (pick: CanvasCommentPick) => {
    openCommentsOn(pick.blockId, pick.part?.kind === "row" ? pick.part.id : undefined);
    if (pick.part !== undefined && pick.part.kind !== "row") {
      setFocusedPart({ kind: pick.part.kind, id: pick.part.id });
    }
  };
  // The Area, Pen, and Text tools: the drawer opens on the block, with the
  // mark waiting for its comment.
  const openCommentsOnMark = (mark: CanvasCommentMark) => {
    openCommentsOn(mark.blockId);
    setDraftMark(mark);
  };
  // Every tool but Select ends in a comment, so a Canvas that takes none
  // keeps the pointer it always had and shows no rail.
  const activeTool: CanvasTool = commentsAvailable ? tool : "select";
  const anchorIds = new Set(canvasCommentAnchorChoices(definition).map((choice) => choice.id));
  const closeComments = () => {
    setDraftMark(undefined);
    setCommentsOpen(false);
    commentsReturnFocus.current?.focus();
    commentsReturnFocus.current = null;
  };

  const openCompare = async () => {
    setVersionsOpen(false);
    if (props.client === undefined || previousEntry === undefined) return;
    // The pair is the one the button named: the version on screen and the one
    // before it, fixed at the click so a later load cannot swap one side.
    const later = { sequence: expectedSequence, definition };
    const outcome = await props.client.get(props.tab.canvasId, String(previousEntry.versionId));
    setCompare(
      outcome.kind === "ready"
        ? {
            kind: "ready",
            earlier: {
              sequence: outcome.version.sequence,
              definition: outcome.version.definition,
            },
            later,
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
              <ChevronDown aria-hidden="true" size={12} />
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
              disabled={loading}
              onClick={() => void openCompare()}
              size="sm"
              type="button"
              variant="secondary"
            >
              Compare with v{previousEntry.sequence}
            </OctantButton>
          )}
        </OctantPopover>
        {/* On the Canvas for as long as it holds, and the way back to the switch. */}
        {network.allowed === true ? (
          <OctantButton
            onClick={() => setDialog("network")}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Globe aria-hidden="true" size={14} />
            Network on
          </OctantButton>
        ) : null}
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
            <MessageSquare aria-hidden="true" size={14} />
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
              if (value === "save-html" || value === "copy-html" || value === "save-tsx") {
                void takeHtmlFile(value);
                return;
              }
              if (value === "propose-deck") {
                void proposeDeck();
                return;
              }
              const chosen = CANVAS_TOOL_DIALOGS.find((candidate) => candidate === value);
              if (chosen === undefined) return;
              setExportTargetId(undefined);
              setDialog(chosen);
            }}
            selectionMode="action"
            trigger={<MoreHorizontal aria-hidden="true" size={16} />}
            triggerClassName="canvas-workspace-tab__overflow"
            triggerLabel="More Canvas actions"
            value=""
          />
        )}
        {htmlFileMessage === undefined ? null : (
          <p
            className="canvas-workspace-tab__notice"
            data-testid="canvas-html-file-status"
            role="status"
          >
            {htmlFileMessage}
          </p>
        )}
      </header>
      <div
        className="canvas-workspace-tab__body"
        data-tools={commentsAvailable ? "true" : "false"}
        onKeyDown={(event) => {
          if (event.key === "Escape" && activeTool !== "select") setTool("select");
        }}
      >
        {commentsAvailable ? <CanvasToolRail onToolChange={setTool} tool={activeTool} /> : null}
        {/* The document scrolls on its own so the drawer beside it stays put,
            and it is its own stacking context so a sticky table header stays
            inside it rather than painting over the drawer's controls. */}
        <CanvasToolSurface
          isAnchor={(choiceId) => anchorIds.has(choiceId)}
          onMark={openCommentsOnMark}
          onPick={openCommentsOnPick}
          tool={activeTool}
        >
          <CanvasView
            input={definition}
            {...(actionRuntime === undefined ? {} : { actionRuntime })}
            {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
            {...(planRuntime === undefined ? {} : { planRuntime })}
            {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
            {...(designRunRuntime === undefined ? {} : { designRunRuntime })}
            choiceRuntime={choiceRuntime}
            {...(commentsAvailable
              ? {
                  comments: {
                    openCounts,
                    openRowCounts,
                    openNodeCounts,
                    marks,
                    onOpen: openCommentsOn,
                  },
                }
              : {})}
          />
        </CanvasToolSurface>
        {commentsClient !== undefined && reviseBase !== null ? (
          <aside
            aria-label="Comments"
            className="canvas-workspace-tab__drawer"
            hidden={!commentsOpen}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // In the narrow dock the Canvas sits inside a modal sheet that
              // also closes on Escape; one press closes the drawer alone.
              event.stopPropagation();
              closeComments();
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
                <X aria-hidden="true" size={14} />
              </OctantButton>
            </div>
            <CanvasCommentsPanel
              author={LOCAL_PERSON}
              canvasId={props.tab.canvasId}
              definition={definition}
              load={commentsClient.load}
              onShowAllBlocks={() => {
                setFocusedBlockId(undefined);
                setFocusedRowId(undefined);
                setFocusedPart(undefined);
              }}
              onDraftMarkDone={() => setDraftMark(undefined)}
              onThreadsChange={setCommentThreads}
              send={commentsClient.send}
              history={history}
              {...(onSendToAgent === undefined ? {} : { onSendToAgent })}
              {...(focusedBlockId === undefined ? {} : { focusedBlockId })}
              {...(focusedRowId === undefined ? {} : { focusedRowId })}
              {...(focusedPart === undefined ? {} : { focusedPart })}
              {...(draftMark === undefined ? {} : { draftMark })}
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
        label="Canvas network"
        onClose={() => setDialog(undefined)}
        open={dialog === "network"}
      >
        <CanvasNetworkPanel network={network} />
      </OctantDialog>
      <OctantDialog
        label="Design system"
        onClose={() => setDialog(undefined)}
        open={dialog === "design-system"}
      >
        {props.client === undefined || definition === undefined ? null : (
          <CanvasDesignSystemPanel
            canvasId={props.tab.canvasId}
            client={props.client}
            current={definition.designSystem}
            expectedSequence={expectedSequence}
            onApplied={async () => {
              await loadCanvas();
              await loadHistory();
              await loadExportOffers();
            }}
          />
        )}
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
            holdsDesign={holdsDesign}
            onOpen={handleOpenShare}
            onRevoke={handleRevokeShare}
            onShare={handleShare}
            overview={shares}
            versionId={selectedVersionId}
            {...(props.client?.sharedDesignPageUrl === undefined
              ? {}
              : { resolveDesignPage: props.client.sharedDesignPageUrl })}
          />
        ) : null}
        {props.client?.publicShares !== undefined ? (
          <CanvasPublicLinksSection
            canvasId={props.tab.canvasId}
            onList={props.client.publicShares}
            {...(props.client.revokePublicShare === undefined
              ? {}
              : { onRevoke: props.client.revokePublicShare })}
            {...(props.client.prepareExport === undefined || props.client.decideExport === undefined
              ? {}
              : {
                  onUpdate: () => {
                    setExportTargetId("public-link");
                    setDialog("export");
                  },
                })}
            revision={publicLinksRevision}
          />
        ) : null}
      </OctantDialog>
      <OctantDialog
        className="canvas-workspace-tab__share-dialog"
        describedBy="canvas-export-description"
        label="Export canvas"
        labelledBy="canvas-export-title"
        onClose={() => setDialog(undefined)}
        open={dialog === "export"}
      >
        {exportOffers !== undefined &&
        props.client?.prepareExport !== undefined &&
        props.client.decideExport !== undefined ? (
          <CanvasExportPanel
            key={`${String(exportOffers.canvasId)}:${String(exportOffers.versionId)}:${exportTargetId ?? ""}`}
            folder={exportFolder}
            {...(exportTargetId === undefined ? {} : { initialTargetId: exportTargetId })}
            offers={exportOffers}
            onDecide={props.client.decideExport}
            onExportFolderChosen={() => void loadExportOffers()}
            onPrepare={prepareExportInTheme}
          />
        ) : null}
      </OctantDialog>
      <OctantDialogPresence>
        {compare !== undefined ? (
          <OctantDialog label="Compare versions" onClose={() => setCompare(undefined)} open>
            {compare?.kind === "ready" ? (
              <CanvasVersionCompare earlier={compare.earlier} later={compare.later} />
            ) : compare?.kind === "unavailable" ? (
              <p className="canvas-compare__note">The earlier version is unavailable.</p>
            ) : null}
          </OctantDialog>
        ) : null}
      </OctantDialogPresence>
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

/** What a new thread is asked to do when a person starts a plan task. */
function planTaskPrompt(planTitle: string, task: CanvasPlanTask): string {
  const notes = task.notes?.trim();
  return [
    `Work on this task from the plan "${planTitle}": ${task.title}`,
    ...(notes === undefined || notes === "" ? [] : [`Done when: ${notes}`]),
  ].join("\n");
}
