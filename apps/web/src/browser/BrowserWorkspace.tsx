import { useBrowserAccountProfiles } from "./useBrowserAccountProfiles";
import { browserProfileFromChoice } from "@octant/domain";
import { browserProfileLabel } from "./browserProfileCopy";
import type { BrowserAgentAvailability } from "@octant/contracts";
import { agentAvailabilityNote } from "./BrowserAgentStatus";
import { useElementWidth } from "./useElementWidth";
import { BrowserCredentialBindingControl } from "./BrowserCredentialBindingControl";
import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserAutomationSnapshot,
  BrowserTaskProfileState,
  BrowserThreadScope,
  BrowserWorkspaceStatus,
} from "@octant/contracts/browser-automation-rpc";
import type {
  BrowserActionKind,
  BrowserActionRequest,
  BrowserCaptureNotKeptReason,
  BrowserCaptureId,
  BrowserContextId,
  BrowserProfile,
  BrowserViewportPoint,
} from "@octant/contracts/browser-automation";
import type { StoredBrowserProfile } from "@octant/contracts/browser-profiles";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";
import { MAX_BROWSER_TABS_PER_CONTEXT } from "@octant/contracts/browser-automation";
import type { ToolActionRequest } from "@octant/contracts/tool-actions";
import { decodeCodeThreadId } from "@octant/contracts/code";
import type { LocalServerOpenTarget, LocalServerSnapshot } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import type { WorkspaceTab } from "@octant/contracts/shell";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Globe2,
  ExternalLink,
  Ellipsis,
  Eye,
  Hand,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  PanelRight,
  PenLine,
  RotateCw,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MiddleTruncatedText } from "../lib/MiddleTruncatedText";
import { OctantButton, OctantIconButton, octantButtonClassName } from "../ui/base/OctantButton";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantInput } from "../ui/base/OctantInput";
import { ShellState } from "../shell/ShellState";
import { ProductFeedbackPanel } from "./ProductFeedbackPanel";
import { useProductFeedback } from "./useProductFeedback";
import { useBrowserFeedbackPointing } from "./useBrowserFeedbackPointing";
import type { OctantHostBridge } from "../shell/hostBridge";
import { useNativeBrowserSurface } from "./useNativeBrowserSurface";
import { BrowserMarkupStage, type MarkupNotice } from "./BrowserMarkupStage";
import {
  MAX_WAITING_OFFERS,
  threadImageOfferKey,
  threadImageOffers,
} from "../composer/threadImageOffers";
import { OctantAlert } from "../ui/base/OctantAlert";
import { useLocalServersController } from "../environment/useLocalServersController";
import { readRecentBrowserPages, recordRecentBrowserPage } from "./recentBrowserPages";
import { BrowserProfileControl } from "./BrowserProfileControl";
import { BrowserExtensionsButton } from "./BrowserExtensionsButton";
import {
  profileChoiceOf,
  readRememberedProfileChoice,
  writeRememberedProfileChoice,
} from "./browserProfileCopy";

/**
 * Renderer chrome a native page must never be painted over. A native view is a
 * window-level sibling rather than a node in the document, so nothing drawn in
 * React can cover it; while any of these is up the page leaves the window.
 */
export const RENDERER_OVERLAY_SELECTOR = [
  ".code-board-layer",
  // A divider being dragged across a tile, or a tab being dragged onto the dock.
  ".dock-tiles__drag-shield",
  ".rail-placeholder",
  ".workspace-drag-preview",
  ".workspace-drop-overlay",
  // A kept capture being drawn on: the page leaves the window for as long as it is up.
  ".browser-markup",
  ".octant-dialog__backdrop",
  ".octant-dialog__viewport",
  ".octant-dialog__popup",
  // Settings floats over a workspace that stays mounted, Browser pane and all.
  ".octant-sheet__backdrop",
  ".octant-sheet__viewport",
  ".octant-sheet__popup",
].join(", ");

const BROWSER_REFRESH_INTERVAL_MS = 500;
const BROWSER_MAX_REFRESH_INTERVAL_MS = 5_000;

export interface BrowserWorkspaceProps {
  readonly client: BrowserAutomationClient;
  readonly onAgentBrowserRecovery?: (
    reason: "no-tool-transport" | "excluded-by-thread-constraints" | "host-lends-no-browser",
  ) => void;
  readonly hostBridge?: OctantHostBridge;
  readonly tab: Extract<WorkspaceTab, { kind: "browser" }>;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /**
   * The Code thread's Project. With it, a Browser that has no page yet offers
   * the servers running for that checkout instead of a placeholder address.
   */
  readonly projectId?: ProjectId;
  /**
   * Dock this thread's research browser into the focus zone. Absent when this
   * window has no zone to dock into. The dock shows the same thread's browsing
   * context under the same authority; docking moves where the page is shown
   * and changes nothing about what may reach it.
   */
  readonly onDockResearch?: (request: {
    readonly threadId: string;
    readonly mode: "work" | "code";
  }) => void;
  /** Reports the isolated context created by a repeatable dock tab. */
  readonly onContextCreated?: (contextId: BrowserContextId) => void;
  /** Opens Settings, where browser extensions are managed. */
  readonly onManageExtensions?: () => void;
  /** A newly added Browser tab must not attach to another tab's current context. */
  readonly startFresh?: boolean;
  /**
   * Offer Draw on page. Only where this thread's message is the place a marked-up
   * picture goes: a Browser with no thread composer beside it offers nothing.
   */
  readonly canDrawOnPage?: boolean;
}

/**
 * The pane width under which the hold button no longer fits beside an address
 * field of at least 120px: three 28px history buttons, the extensions and more
 * buttons, the hold button, 4px gaps and the row's insets.
 */
const HOLD_FOLD_WIDTH = 340;

export function BrowserWorkspace(props: BrowserWorkspaceProps) {
  const [url, setUrl] = useState("");
  // A server suggestion fills the address only until the person types one.
  const [addressTyped, setAddressTyped] = useState(false);
  const [scope, setScope] = useState<BrowserThreadScope>();
  const [snapshot, setSnapshot] = useState<BrowserAutomationSnapshot>();
  const [agentRead, setAgentRead] = useState<{
    readonly client: BrowserAutomationClient;
    readonly threadId: string;
    readonly availability: BrowserAgentAvailability | undefined;
  }>();
  const agentAvailability =
    agentRead?.client === props.client && agentRead.threadId === props.tab.threadId
      ? agentRead.availability
      : undefined;

  const [status, setStatus] = useState<BrowserWorkspaceStatus>(
    props.tab.threadId === undefined ? "unavailable" : "ready",
  );
  const [message, setMessage] = useState<string>();
  // A capture the host declined to keep is said once, apart from `message`,
  // because every poll of the page rewrites `message`.
  const [captureNotice, setCaptureNotice] = useState<string>();
  // A confirmation is not a warning: "Added to the message" wears the neutral or
  // success treatment, a refused capture the warning one.
  const [captureNoticeTone, setCaptureNoticeTone] = useState<"warning" | "neutral" | "success">(
    "warning",
  );
  // What happened to the picture while it is being drawn on. It is drawn in the
  // stage, above the bar, so it never moves the still.
  const [markupNotice, setMarkupNotice] = useState<MarkupNotice>();
  const [capturing, setCapturing] = useState(false);
  // The person's own kept capture while it is being drawn on; its marks live in
  // the stage and are dropped with it.
  const [markupPicture, setMarkupPicture] = useState<string>();
  // Each Draw on page press holds a number; leaving the page, changing context,
  // or unmounting moves it on, so a still that arrives late is not opened over a
  // page the person has already left.
  const markupRequest = useRef(0);
  const chrome = useRef<HTMLElement>(null);
  const moreAnchor = useRef<HTMLSpanElement>(null);
  // The more menu's trigger button, found when focus returns to it.
  const moreTrigger = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return moreAnchor.current?.querySelector("button") ?? null;
      },
    }),
    [],
  );
  const [credentialRequest, setCredentialRequest] = useState(0);
  const focusDrawButton = useRef(false);
  const [starting, setStarting] = useState(false);
  const [ownedContextId, setOwnedContextId] = useState<BrowserContextId | undefined>(
    props.tab.contextId,
  );
  const [nativeSupported, setNativeSupported] = useState(false);
  const accounts = useBrowserAccountProfiles(props.client, nativeSupported);
  // Where the next page keeps its site data. A new page opens Private unless the
  // person chose otherwise for this Project, which the control remembers. The
  // Project is the thread's own, asked of the host: not every entry point to a
  // Browser tab knows it, and a preference keyed by anything else would carry one
  // Project's choice into another's.
  const [profileKey, setProfileKey] = useState<string | undefined>(
    props.projectId === undefined ? undefined : String(props.projectId),
  );
  const [profileChoice, setProfileChoice] = useState<BrowserProfileChoice>(() =>
    props.projectId === undefined
      ? "private"
      : readRememberedProfileChoice(String(props.projectId)),
  );
  const [taskProfileReadState, setTaskProfileReadState] = useState<{
    readonly client: BrowserAutomationClient;
    readonly threadId: BrowserTaskProfileState["threadId"];
    readonly mode: BrowserTaskProfileState["mode"];
    readonly status: "pending" | "ready" | "error";
    readonly selection?: BrowserTaskProfileState;
  }>();
  const currentTaskProfileScope = useRef({
    client: props.client,
    threadId: props.tab.threadId,
    mode: props.tab.mode,
  });
  currentTaskProfileScope.current = {
    client: props.client,
    threadId: props.tab.threadId,
    mode: props.tab.mode,
  };
  const scopedTaskProfileRead =
    taskProfileReadState?.client === props.client &&
    taskProfileReadState.threadId === props.tab.threadId &&
    taskProfileReadState.mode === props.tab.mode
      ? taskProfileReadState
      : undefined;
  const taskProfile = scopedTaskProfileRead?.selection;
  const taskProfileRead = scopedTaskProfileRead?.status ?? "pending";
  const [taskProfileRetry, setTaskProfileRetry] = useState(0);
  const [pendingTaskProfile, setPendingTaskProfile] = useState<BrowserProfileChoice>();
  const [selectingTaskProfile, setSelectingTaskProfile] = useState(false);
  const taskProfileSupported =
    props.tab.threadId !== undefined &&
    props.client.readTaskProfile !== undefined &&
    props.client.selectTaskProfile !== undefined;
  const taskProfileApplies =
    taskProfileSupported &&
    taskProfileRead === "ready" &&
    !props.startFresh &&
    (snapshot?.context === undefined || snapshot.context.contextId === taskProfile?.contextId);
  useEffect(() => {
    const read = props.client.readTaskProfile;
    const threadId = props.tab.threadId;
    const mode = props.tab.mode;
    if (!taskProfileSupported || read === undefined || threadId === undefined) return;
    const controller = new AbortController();
    const scope = { client: props.client, threadId, mode };
    setTaskProfileReadState({ ...scope, status: "pending" });
    void read
      .call(props.client, { threadId, mode }, controller.signal)
      .then((selection) => {
        if (selection.threadId !== threadId || selection.mode !== mode)
          throw new Error("Task Browser profile scope changed.");
        if (!controller.signal.aborted) {
          setTaskProfileReadState({ ...scope, status: "ready", selection });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setTaskProfileReadState({ ...scope, status: "error" });
      });
    return () => controller.abort();
  }, [
    props.client,
    props.tab.threadId,
    props.tab.mode,
    snapshot?.context?.contextId,
    taskProfileSupported,
    taskProfileRetry,
  ]);
  useEffect(() => {
    setPendingTaskProfile(undefined);
    setSelectingTaskProfile(false);
  }, [props.client, props.tab.threadId, props.tab.mode]);
  const chosenByPerson = useRef(false);
  // The context a profile switch created for a tab that was bound to another one.
  const [replacementContextId, setReplacementContextId] = useState<BrowserContextId>();
  const switchingProfile = useRef(false);
  const threadIdForProfile = props.tab.threadId;
  const modeForProfile = props.tab.mode;
  const resolveForProfile = props.client.resolve;
  useEffect(() => {
    if (profileKey !== undefined || threadIdForProfile === undefined) return;
    let current = true;
    Promise.resolve()
      .then(() =>
        resolveForProfile.call(props.client, {
          threadId: threadIdForProfile,
          mode: modeForProfile,
        }),
      )
      .then((resolved) => {
        if (!current) return;
        const key = String(resolved?.authority.projectId ?? "");
        if (key === "") return;
        setProfileKey(key);
        if (!chosenByPerson.current) setProfileChoice(readRememberedProfileChoice(key));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [modeForProfile, profileKey, props.client, resolveForProfile, threadIdForProfile]);
  const [remoteFocused, setRemoteFocused] = useState(false);
  // Pointing at the page is a separate gesture from using it: while it is on, a
  // click marks a spot to write about instead of clicking through to the page.
  const feedback = useProductFeedback({
    threadId: props.tab.threadId === undefined ? undefined : String(props.tab.threadId),
    mode: props.tab.mode,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const startInFlight = useRef(false);
  const localFailure = useRef(false);
  const localFailureRevision = useRef<string | undefined>(undefined);
  const currentSnapshotRevision = useRef<string | undefined>(undefined);
  const lastPolledRevision = useRef<string | undefined>(undefined);
  const unchangedPolls = useRef(0);
  const currentObservationRevision =
    useRef<BrowserActionRequest["expectedObservationRevision"]>(undefined);
  const remoteActionTail = useRef<Promise<void>>(Promise.resolve());
  const activeContext = snapshot?.context?.state === "active";
  const nativeContext = nativeSupported && snapshot?.context?.presentation !== "headless";
  const nativeSurface = useNativeBrowserSurface({
    ...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge }),
    ...(snapshot?.context?.contextId === undefined
      ? {}
      : { contextId: String(snapshot.context.contextId) }),
    ...(props.tab.threadId === undefined ? {} : { threadId: String(props.tab.threadId) }),
    enabled: nativeContext && activeContext,
    overlaySelector: RENDERER_OVERLAY_SELECTOR,
  });
  const nativeState = nativeSurface.state;
  // A page that is gone leaves nothing to draw on.
  useEffect(() => {
    if (!activeContext) leaveMarkup();
  }, [activeContext]);
  const markupContextId = snapshot?.context?.contextId;
  useEffect(() => {
    markupRequest.current += 1;
  }, [markupContextId]);
  useEffect(
    () => () => {
      markupRequest.current += 1;
    },
    [],
  );
  // Close and a picture left waiting for its composer hand focus back to the
  // button that opened drawing, instead of letting it fall to the page body.
  useEffect(() => {
    if (markupPicture !== undefined || !focusDrawButton.current) return;
    focusDrawButton.current = false;
    moreTrigger.current?.focus();
  }, [markupPicture]);
  const feedbackSelectionUnavailable =
    markupPicture !== undefined
      ? "Finish or discard the drawing before choosing an element."
      : !activeContext
        ? "Open a Browser page before choosing an element."
        : snapshot?.waitingForPerson === "sign-in"
          ? "Finish sign-in and Continue before choosing an element."
          : nativeSurface.embedded !== undefined
            ? "Element selection is not available in this embedded Browser presentation yet."
            : nativeContext &&
                (props.hostBridge?.selectBrowserSurfacePoint === undefined ||
                  props.hostBridge.subscribeBrowserSurfaceState === undefined)
              ? "This app build cannot select a native Browser element."
              : !nativeContext && snapshot?.observation?.screenshotDataUrl === undefined
                ? "Refresh the page preview before choosing an element."
                : undefined;
  const feedbackPointing = useBrowserFeedbackPointing({
    contextId:
      snapshot?.context?.contextId === undefined ? undefined : String(snapshot.context.contextId),
    threadId: props.tab.threadId === undefined ? undefined : String(props.tab.threadId),
    native: nativeContext,
    feedback,
    ...(props.hostBridge === undefined ? {} : { bridge: props.hostBridge }),
    ...(feedbackSelectionUnavailable === undefined
      ? {}
      : { unavailableReason: feedbackSelectionUnavailable }),
  });
  const codeThreadId = useMemo(
    () =>
      props.tab.mode === "code" && props.tab.threadId !== undefined
        ? decodeCodeThreadId(String(props.tab.threadId))
        : undefined,
    [props.tab.mode, props.tab.threadId],
  );
  // Watched only while no page is open: once one is, the address bar is the
  // person's, and the Environment tab is where servers are watched live.
  const localServers = useLocalServersController({
    enabled: codeThreadId !== undefined && !activeContext,
    poll: !activeContext,
    ...(codeThreadId === undefined ? {} : { threadId: codeThreadId }),
    ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const serverSuggestions = useMemo(
    () =>
      codeThreadId !== undefined &&
      localServers.snapshot !== undefined &&
      String(localServers.snapshot.threadId) === String(codeThreadId)
        ? openableServers(localServers.snapshot)
        : [],
    [codeThreadId, localServers.snapshot],
  );
  const [recentPages, setRecentPages] = useState(() => readRecentBrowserPages());
  // A running server is already offered under Local; its address is not
  // offered twice.
  const recentSuggestions = useMemo(
    () =>
      recentPages.filter((page) => !serverSuggestions.some((server) => server.url === page.url)),
    [recentPages, serverSuggestions],
  );
  const firstSuggestion = serverSuggestions[0]?.url;
  useEffect(() => {
    if (!addressTyped && !activeContext && firstSuggestion !== undefined) setUrl(firstSuggestion);
  }, [activeContext, addressTyped, firstSuggestion]);

  const committedAddress = activeContext
    ? ((nativeContext ? nativeState?.url : undefined) ?? snapshot?.observation?.url)
    : undefined;
  // Every page the Browser commits counts as recent, however it was reached:
  // the address bar, a server row, a conversation link that opened its own
  // context, or a navigation within the open page.
  useEffect(() => {
    if (committedAddress === undefined || !/^https?:/i.test(committedAddress)) return;
    setRecentPages(recordRecentBrowserPage(committedAddress));
  }, [committedAddress]);
  const secureAddress = committedAddress?.toLocaleLowerCase().startsWith("https:") === true;
  const addressSecurityLabel =
    committedAddress === undefined ? "Address" : secureAddress ? "Secure HTTPS" : "Not secure HTTP";
  // The person holds the page: every agent Browser call on it is refused until
  // they hand it back. The server decides; this only shows it.
  const personHasPage = activeContext && snapshot?.waitingForPerson === "take-over";
  const driverLabel = personHasPage
    ? snapshot?.ownerController === undefined
      ? "You have the page"
      : `Owner: ${snapshot.ownerController.name}`
    : !nativeContext
      ? "Preview"
      : nativeSurface.failed
        ? "Live page unavailable"
        : nativeState?.control === "agent"
          ? "Agent active"
          : nativeState?.control === "user"
            ? "You control"
            : "Shared live page";
  // While the agent drives a signed-in page the indicator names the profile, so
  // it is plain whose account the agent is acting as.
  const drivenProfile = storedProfileOf(snapshot?.context?.policy.profile);
  const controlLabel =
    drivenProfile !== undefined && nativeState?.control === "agent"
      ? `${driverLabel} · ${browserProfileLabel(profileChoiceOf(drivenProfile), accounts)}`
      : driverLabel;

  useEffect(() => {
    let active = true;
    void Promise.resolve(props.hostBridge?.getHostCapabilities?.()).then((capabilities) => {
      if (active) setNativeSupported(capabilities?.liveBrowserSupported === true);
    });
    return () => {
      active = false;
    };
  }, [props.hostBridge]);

  useEffect(() => {
    if (nativeState?.url) setUrl(nativeState.url);
  }, [nativeState?.url]);

  useEffect(() => {
    if (nativeState?.url === undefined && snapshot?.observation?.url) {
      setUrl(snapshot.observation.url);
    }
  }, [nativeState?.url, snapshot?.observation?.url]);

  useEffect(() => {
    if (props.tab.threadId === undefined) return;
    const contextId = replacementContextId ?? props.tab.contextId ?? ownedContextId;
    const fresh = props.startFresh === true && contextId === undefined;
    const controller = new AbortController();
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus(fresh ? "ready" : "waiting");
    const refresh = async () => {
      let nextDelay = BROWSER_REFRESH_INTERVAL_MS;
      try {
        // A tab opened for one host-owned context shows that context and no
        // other: asking for the thread's current context instead
        // would move this tab onto whatever was opened last.
        const next =
          contextId === undefined
            ? await props.client.inspectThread(
                { threadId: props.tab.threadId!, ...(fresh ? { freshPicture: false } : {}) },
                controller.signal,
              )
            : await props.client.inspect(
                { contextId, threadId: props.tab.threadId! },
                controller.signal,
              );
        if (!active || controller.signal.aborted) return;
        const availability = next.agentAvailability;
        setAgentRead((previous) =>
          previous?.client === props.client &&
          previous.threadId === String(props.tab.threadId) &&
          JSON.stringify(previous.availability) === JSON.stringify(availability)
            ? previous
            : {
                client: props.client,
                threadId: String(props.tab.threadId),
                availability,
              },
        );
        const revision = fresh ? JSON.stringify(availability) : snapshotRevision(next);
        const changed = revision !== lastPolledRevision.current;
        lastPolledRevision.current = revision;
        unchangedPolls.current = changed ? 0 : unchangedPolls.current + 1;
        nextDelay = browserRefreshDelay(unchangedPolls.current);
        // A fresh tab reads only the thread's admission fact. Its current page
        // belongs to another tab until this one creates its own context.
        if (fresh) {
          setStatus("ready");
          return;
        }
        if (changed) {
          currentSnapshotRevision.current = revision;
          currentObservationRevision.current = next.observation?.revision;
          setSnapshot(next);
          setScope(
            next.context === undefined
              ? undefined
              : { threadId: next.threadId, authority: next.context.authority },
          );
        }
        const recovered =
          localFailure.current &&
          next.failure === undefined &&
          revision !== localFailureRevision.current;
        if (!localFailure.current || recovered) {
          if (recovered) {
            localFailure.current = false;
            localFailureRevision.current = undefined;
          }
          setStatus(next.status);
          setMessage(next.failure?.message);
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setAgentRead(undefined);
        // A refusal is a state, not a reason to ask harder. Without this the
        // loop re-asks a refused context at the base interval and the renderer
        // logs an HTTP error for every attempt; a snapshot that changes still
        // resets the counter and returns to the base interval.
        unchangedPolls.current += 1;
        nextDelay = browserRefreshDelay(unchangedPolls.current);
        // A page this tab held that the host no longer has (Octant restarted,
        // or it was closed elsewhere) is not an error to read: the tab simply
        // has no page, so it shows its start page. The host's wording,
        // "Browser context is stale or no longer owned", meant nothing to the
        // person who had done nothing.
        if (error instanceof BrowserAutomationClientFailure && error.category === "stale") {
          setSnapshot(undefined);
          setStatus("ready");
          setMessage(undefined);
          return;
        }
        applyFailure(error, setStatus, setMessage);
      } finally {
        if (active && !controller.signal.aborted) {
          refreshTimer = setTimeout(() => void refresh(), nextDelay);
        }
      }
    };
    void refresh();
    return () => {
      active = false;
      controller.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [
    ownedContextId,
    props.client,
    props.startFresh,
    props.tab.contextId,
    props.tab.threadId,
    replacementContextId,
  ]);

  if (props.tab.threadId === undefined) {
    return (
      <section
        aria-label="Browser automation"
        className="browser-workspace browser-workspace--state"
      >
        <ShellState
          eyebrow="Browser unavailable"
          message="The host requires one exact owning thread before it can create an isolated context."
          state="neutral"
          title="Open Browser from a Work or Code thread"
        />
      </section>
    );
  }

  async function start(
    address: string = url,
    prepared?: LocalServerOpenTarget,
    choice: BrowserProfileChoice = taskProfileApplies
      ? (taskProfile?.profile ?? "private")
      : profileChoice,
    explicitPrivate = false,
  ): Promise<void> {
    if (startInFlight.current) return;
    if (
      taskProfileSupported &&
      !props.startFresh &&
      taskProfileRead !== "ready" &&
      !(taskProfileRead === "error" && explicitPrivate && choice === "private")
    ) {
      setMessage(
        taskProfileRead === "error"
          ? "The task’s default could not be loaded. Retry, or explicitly open a Private page below."
          : "The task’s Browser profile is loading. Try again shortly.",
      );
      return;
    }
    startInFlight.current = true;
    localFailure.current = false;
    setStarting(true);
    setStatus("waiting");
    setMessage(undefined);
    try {
      const targetUrl = validTargetUrl(address);
      if (targetUrl === undefined) return;
      const origin = prepared?.allowedOrigin ?? new URL(targetUrl).origin;
      setUrl(targetUrl);
      const resolved = await props.client.resolve({
        threadId: props.tab.threadId!,
        mode: props.tab.mode,
      });
      const action = makeAction(resolved);
      const profile = storedProfileFor(choice, resolved.authority.projectId);
      if (choice === "project" && profile === undefined) {
        localFailure.current = true;
        setStatus("failed");
        setMessage("This thread has no Project profile.");
        return;
      }
      const next = await props.client.create({
        threadId: props.tab.threadId!,
        action,
        policy: {
          profileMode: "isolated",
          ...(profile === undefined ? {} : { profile }),
          allowedOrigins: [origin],
          credentialFieldProtection: true,
          maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
          sessionTimeoutMs: 300_000,
          ...(prepared?.acceptsLocalCertificate === true ? { acceptsLocalCertificate: true } : {}),
        },
        // A tab bound to one context is replaced by a context of its own, never by
        // whatever shared context the thread already holds.
        ...(switchingProfile.current ? { dedicated: true } : {}),
      });
      setScope(resolved);
      update(next);
      if (next.context !== undefined) {
        if (next.context.state === "active") {
          const navigated = await props.client.act({
            actionId: next.context.actionId,
            contextId: next.context.contextId,
            correlationId: next.context.correlationId,
            authority: resolved.authority,
            kind: "navigate",
            target: targetUrl,
          });
          update(navigated);
        }
      }
      if (props.startFresh === true && next.context !== undefined) {
        setOwnedContextId(next.context.contextId);
        props.onContextCreated?.(next.context.contextId);
      }
      if (switchingProfile.current && next.context !== undefined) {
        // The tab now shows the replacement; polling the stopped context would
        // swap the old page back in.
        setReplacementContextId(next.context.contextId);
        props.onContextCreated?.(next.context.contextId);
      }
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    } finally {
      startInFlight.current = false;
      setStarting(false);
    }
  }

  async function act(
    kind: BrowserActionKind,
    input: Partial<
      Pick<
        BrowserActionRequest,
        "target" | "value" | "point" | "deltaX" | "deltaY" | "expectedObservationRevision"
      >
    > = {},
  ): Promise<void> {
    if (snapshot?.context === undefined || scope === undefined) return;
    // The page is about to change under the picture: the marks go with it.
    leaveMarkup();
    localFailure.current = false;
    setStatus("waiting");
    setMessage(undefined);
    setCaptureNotice(undefined);
    try {
      const next = await props.client.act({
        actionId: snapshot.context.actionId,
        contextId: snapshot.context.contextId,
        correlationId: snapshot.context.correlationId,
        authority: scope.authority,
        kind,
        ...input,
        ...(kind === "navigate" ? { target: input.target ?? normalizeBrowserUrl(url) } : {}),
      });
      update(next);
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    }
  }

  /**
   * The person's Screenshot control: the one pane gesture that keeps a picture
   * with the thread. Refreshing the preview is an ordinary action and keeps none.
   * Answers the kept capture's id, or undefined when none was kept.
   */
  async function keepScreenshot(
    purpose: "screenshot" | "drawing" = "screenshot",
  ): Promise<BrowserCaptureId | undefined> {
    const takeCapture = props.client.takeCapture;
    if (
      snapshot?.context === undefined ||
      scope === undefined ||
      props.tab.threadId === undefined ||
      takeCapture === undefined
    ) {
      return undefined;
    }
    localFailure.current = false;
    setCapturing(true);
    setCaptureNotice(undefined);
    setCaptureNoticeTone("warning");
    setMessage(undefined);
    try {
      const next = await takeCapture.call(props.client, {
        threadId: props.tab.threadId,
        request: {
          actionId: snapshot.context.actionId,
          contextId: snapshot.context.contextId,
          correlationId: snapshot.context.correlationId,
          authority: scope.authority,
          kind: "screenshot",
        },
      });
      update(next);
      const capture = next.observation?.capture;
      if (capture?.status === "not-kept") {
        setCaptureNotice(captureNotKeptNotice(capture.reason, purpose));
      }
      return capture?.status === "kept" ? capture.captureId : undefined;
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
      return undefined;
    } finally {
      setCapturing(false);
    }
  }

  async function takeScreenshot(): Promise<void> {
    await keepScreenshot();
  }

  /**
   * Draw on page: keep a screenshot exactly as the Screenshot control does,
   * then draw on that kept picture. No other source of pixels is read, so the
   * credential-field refusal, the journal record and the origin's taint all
   * apply as they do for any capture.
   */
  async function startMarkup(): Promise<void> {
    const readCapture = props.client.readCapture;
    const threadId = props.tab.threadId;
    if (readCapture === undefined || threadId === undefined) return;
    const request = ++markupRequest.current;
    const captureId = await keepScreenshot("drawing");
    if (captureId === undefined || request !== markupRequest.current) return;
    try {
      const image = await readCapture.call(props.client, { threadId, captureId });
      if (request === markupRequest.current) setMarkupPicture(image.dataUrl);
    } catch {
      if (request === markupRequest.current) {
        setCaptureNotice("The kept screenshot could not be opened for drawing.");
      }
    }
  }

  /** Drop the drawing and any still on its way; its marks go with it. */
  function leaveMarkup(): void {
    markupRequest.current += 1;
    setMarkupPicture(undefined);
    setMarkupNotice(undefined);
  }

  function closeMarkup(): void {
    focusDrawButton.current = true;
    leaveMarkup();
  }

  /**
   * Hand the marked-up picture to the thread's composer and say what it made of
   * it. Only a picture the composer attached ends drawing; a refusal leaves the
   * drawing as it is, with the composer's reason.
   */
  async function addMarkupToMessage(file: File): Promise<void> {
    if (props.tab.threadId === undefined) return;
    setMarkupNotice(undefined);
    // The hand-off can outlast this drawing: the Code composer uploads the
    // picture before it answers. A drawing the person closed meanwhile, or a
    // new one they opened, is not closed or told about the old picture.
    const drawing = markupRequest.current;
    const result = await threadImageOffers.offer(
      threadImageOfferKey(props.tab.mode, String(props.tab.threadId)),
      file,
    );
    if (drawing !== markupRequest.current) return;
    if (result.status === "full") {
      setMarkupNotice({
        tone: "danger",
        text: `This thread already has ${String(MAX_WAITING_OFFERS)} pictures waiting for its message. Open the thread and send or remove one first.`,
      });
      return;
    }
    if (result.status === "refused") {
      setMarkupNotice({
        tone: "danger",
        text: `The picture was not added to the message: ${result.reason}`,
      });
      return;
    }
    // A composer that is open takes focus for its prompt; otherwise it stays here.
    if (result.status === "waiting") focusDrawButton.current = true;
    leaveMarkup();
    setCaptureNoticeTone(result.status === "added" ? "success" : "neutral");
    setCaptureNotice(
      result.status === "added"
        ? "Added to the message"
        : "Added to the message when you open this thread",
    );
  }

  async function stop(cancel: boolean): Promise<void> {
    if (snapshot?.context === undefined) return;
    localFailure.current = false;
    setStatus("waiting");
    try {
      const next = cancel
        ? await props.client.cancel({
            contextId: snapshot.context.contextId,
            threadId: props.tab.threadId!,
            cancellation: {
              actionId: snapshot.context.actionId,
              correlationId: snapshot.context.correlationId,
              authority: snapshot.context.authority,
              reason: "user-requested",
            },
          })
        : await props.client.stop({
            contextId: snapshot.context.contextId,
            threadId: props.tab.threadId!,
          });
      update(next);
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    }
  }

  /**
   * Take the page from the agent, or give it back. The server holds the agent's
   * Browser calls and decides who may; this asks and shows the answer.
   */
  async function holdPage(hold: "take-over" | "hand-back"): Promise<void> {
    const ask = hold === "take-over" ? props.client.takeOver : props.client.handBack;
    if (ask === undefined || props.tab.threadId === undefined) return;
    localFailure.current = false;
    try {
      update(await ask.call(props.client, { threadId: props.tab.threadId }));
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    }
  }

  function update(next: BrowserAutomationSnapshot): void {
    localFailure.current = next.failure !== undefined;
    currentSnapshotRevision.current = snapshotRevision(next);
    currentObservationRevision.current = next.observation?.revision;
    localFailureRevision.current =
      next.failure === undefined ? undefined : currentSnapshotRevision.current;
    unchangedPolls.current = 0;
    setSnapshot(next);
    setStatus(next.status);
    setMessage(next.failure?.message);
  }

  function queueRemoteAction(
    kind: "click" | "type" | "press" | "scroll",
    input: Partial<Pick<BrowserActionRequest, "value" | "point" | "deltaX" | "deltaY">>,
  ): void {
    if (currentObservationRevision.current === undefined) return;
    remoteActionTail.current = remoteActionTail.current
      .catch(() => undefined)
      .then(() =>
        act(kind, {
          ...input,
          expectedObservationRevision: currentObservationRevision.current!,
        }),
      );
  }

  /**
   * Open a suggested server through the host's Open preparation, as Local
   * servers does: an HTTPS dev server's self-signed localhost certificate is
   * accepted only for a target the host prepared, so the raw URL would stop on
   * a certificate error.
   */
  async function openServer(server: LocalServerSnapshot["currentCheckout"][number]): Promise<void> {
    if (startInFlight.current) return;
    setUrl(server.url);
    const target = await localServers.open(server.listenerId);
    if (target === undefined) {
      localFailure.current = true;
      setStatus("failed");
      setMessage("Octant could not prepare this server to open. Check Local servers.");
      return;
    }
    await start(target.url, target);
  }

  /** The address the person left on a suggested server still opens as that server. */
  async function startFromAddress(): Promise<void> {
    const server = serverSuggestions.find((suggestion) => suggestion.url === url);
    await (server === undefined ? start() : openServer(server));
  }

  async function navigate(): Promise<void> {
    if (!activeContext) {
      await startFromAddress();
      return;
    }
    const target = validTargetUrl(url);
    if (target === undefined) return;
    const targetOrigin = new URL(target).origin;
    const allowed = snapshot?.context?.policy.allowedOrigins.some(
      (origin) => new URL(normalizeBrowserUrl(origin)).origin === targetOrigin,
    );
    if (allowed) {
      await act("navigate");
      return;
    }
    await stop(false);
    await start();
  }

  /**
   * Move this page to another profile. A page's store is fixed when it opens, so
   * the same address opens again as a new browsing context in the chosen profile
   * and the old context closes; nothing it held carries over.
   */
  async function selectTaskProfile(choice: BrowserProfileChoice): Promise<void> {
    const select = props.client.selectTaskProfile;
    const selection = taskProfile;
    if (
      select === undefined ||
      selection === undefined ||
      taskProfileRead !== "ready" ||
      selectingTaskProfile
    )
      return;
    const sameScope = () =>
      currentTaskProfileScope.current.client === props.client &&
      currentTaskProfileScope.current.threadId === props.tab.threadId &&
      currentTaskProfileScope.current.mode === props.tab.mode;
    const acceptSelection = (next: BrowserTaskProfileState) => {
      if (!sameScope()) return;
      setTaskProfileReadState({
        client: props.client,
        threadId: next.threadId,
        mode: next.mode,
        status: "ready",
        selection: next,
      });
    };
    setSelectingTaskProfile(true);
    try {
      const address = committedAddress ?? validTargetUrl(url);
      const result = await select.call(props.client, {
        threadId: selection.threadId,
        mode: selection.mode,
        expectedVersion: selection.version,
        profile: choice,
        ...(selection.contextId === undefined ? {} : { expectedContextId: selection.contextId }),
        ...(activeContext && address !== undefined ? { url: address } : {}),
      });
      if (!sameScope()) return;
      acceptSelection(result.selection);
      update(result.browser);
      if (result.browser.context?.state === "active") {
        if (props.startFresh) setOwnedContextId(result.browser.context.contextId);
        if (props.tab.contextId !== undefined)
          setReplacementContextId(result.browser.context.contextId);
        if (props.startFresh || props.tab.contextId !== undefined)
          props.onContextCreated?.(result.browser.context.contextId);
      }
      setMessage(
        "Default Browser profile saved for this task. Agents still need permission to use a signed-in profile.",
      );
    } catch (error) {
      if (!sameScope()) return;
      localFailure.current = true;
      setMessage(
        error instanceof Error
          ? error.message
          : "The task’s Browser profile could not be changed. The original page was kept.",
      );
      // A version conflict must be retryable without replacing the held page.
      try {
        const refreshed = await props.client.readTaskProfile?.({
          threadId: selection.threadId,
          mode: selection.mode,
        });
        if (refreshed !== undefined) acceptSelection(refreshed);
      } catch {
        /* Keep the last choice visible while the host is unavailable. */
      }
    } finally {
      if (sameScope()) {
        setSelectingTaskProfile(false);
        setPendingTaskProfile(undefined);
      }
    }
  }

  async function chooseProfile(choice: BrowserProfileChoice): Promise<void> {
    if (taskProfileApplies) {
      if (choice === taskProfile?.profile) return;
      if (activeContext) setPendingTaskProfile(choice);
      else await selectTaskProfile(choice);
      return;
    }
    chosenByPerson.current = true;
    if (profileKey !== undefined) writeRememberedProfileChoice(profileKey, choice);
    setProfileChoice(choice);
    if (!activeContext) return;
    const address = committedAddress ?? validTargetUrl(url);
    if (address === undefined) return;
    await stop(false);
    switchingProfile.current =
      props.tab.contextId !== undefined || replacementContextId !== undefined;
    try {
      await start(address, undefined, choice);
    } finally {
      switchingProfile.current = false;
    }
  }

  async function signOutOfProfile(): Promise<void> {
    const stored = storedProfileOf(snapshot?.context?.policy.profile);
    const manage = props.client.manageProfiles;
    if (stored === undefined || manage === undefined) return;
    try {
      const result = await manage.call(props.client, {
        kind: "clear",
        profile: stored,
        scope: "all",
      });
      setMessage(
        result.kind === "browser-profiles-refused"
          ? result.message
          : "Signed out. Every page in this profile closed.",
      );
    } catch {
      setMessage("The profile could not be cleared.");
    }
  }

  function nativeCommand(command: "back" | "forward" | "reload" | "stop"): void {
    if (snapshot?.context === undefined || props.hostBridge?.commandBrowserSurface === undefined)
      return;
    leaveMarkup();
    void props.hostBridge
      .commandBrowserSurface({
        contextId: snapshot.context.contextId,
        threadId: props.tab.threadId!,
        command,
      })
      .catch(() => undefined);
  }

  function validTargetUrl(value: string): string | undefined {
    try {
      return normalizeBrowserUrl(value);
    } catch {
      localFailure.current = true;
      setStatus("failed");
      setMessage("Enter a valid HTTP or HTTPS address.");
      return undefined;
    }
  }

  const notice = message ?? captureNotice;
  const showFeedback =
    feedback.available &&
    (snapshot?.context !== undefined ||
      feedback.preview !== undefined ||
      feedback.pending.length > 0);
  const feedbackNotice = feedbackPointing.message ?? feedback.message;

  const agentDriving = nativeState?.control === "agent";
  const agentNote = agentAvailabilityNote(agentAvailability);
  const idleNote = !activeContext
    ? undefined
    : snapshot?.waitingForPerson === undefined
      ? `${Math.ceil((snapshot?.context?.policy.sessionTimeoutMs ?? 600_000) / 60_000)}m idle`
      : "Person hold";
  // One status mark in the address field says who may use the page, who holds
  // it and for how long; the words are its name and tooltip, not a row of text.
  const statusText = [
    agentDriving ? undefined : agentNote.message,
    [controlLabel, idleNote].filter((part) => part !== undefined).join(" · "),
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const holdAction =
    activeContext && personHasPage && props.client.handBack !== undefined
      ? ({
          hold: "hand-back",
          label: "Hand back",
          title: "You have the page. Hand it back to let the agent use it again.",
        } as const)
      : activeContext &&
          snapshot?.waitingForPerson === undefined &&
          props.client.takeOver !== undefined
        ? ({
            hold: "take-over",
            label: "Take over",
            title: "Hold the agent's Browser calls while you use the page",
          } as const)
        : undefined;
  // The row keeps the address at least ADDRESS_MIN_WIDTH wide: when the pane is
  // too narrow for the hold button beside it, that button moves into the more
  // menu. Back, forward and reload stay.
  const chromeWidth = useElementWidth(chrome);
  const foldHold = chromeWidth !== undefined && chromeWidth < HOLD_FOLD_WIDTH;
  const canCredential =
    nativeContext !== undefined &&
    activeContext &&
    props.client.manageCredentialUse !== undefined &&
    (snapshot?.context?.authority.mode === "work" || snapshot?.context?.authority.mode === "code");
  const moreItems: ReadonlyArray<OctantMenuItem> = [
    ...(holdAction !== undefined && foldHold
      ? [
          {
            icon:
              holdAction.hold === "hand-back" ? (
                <Undo2 aria-hidden="true" size={16} />
              ) : (
                <Hand aria-hidden="true" size={16} />
              ),
            label: holdAction.label,
            value: holdAction.hold,
          },
        ]
      : []),
    ...(activeContext &&
    snapshot?.ownerController !== undefined &&
    props.client.takeOver !== undefined
      ? [
          {
            icon: <Laptop aria-hidden="true" size={16} />,
            label: "Reclaim locally",
            value: "reclaim",
          },
        ]
      : []),
    ...(activeContext && props.client.takeCapture !== undefined
      ? [
          {
            disabled: capturing,
            icon: <Camera aria-hidden="true" size={16} />,
            label: "Screenshot",
            value: "screenshot",
          },
        ]
      : []),
    ...(activeContext &&
    props.canDrawOnPage === true &&
    props.tab.threadId !== undefined &&
    props.client.takeCapture !== undefined &&
    props.client.readCapture !== undefined
      ? [
          {
            description: feedbackPointing.pointing
              ? "Finish or cancel pointing at an element before drawing on the page"
              : markupPicture !== undefined
                ? "A drawing is already open"
                : "Keeps a screenshot with this thread",
            disabled: capturing || markupPicture !== undefined || feedbackPointing.pointing,
            icon: <PenLine aria-hidden="true" size={16} />,
            label: "Draw on page",
            value: "draw",
          },
        ]
      : []),
    ...(activeContext && props.hostBridge?.openBrowserExternal !== undefined
      ? [
          {
            icon: <ExternalLink aria-hidden="true" size={16} />,
            label: "Open in default browser",
            value: "external",
          },
        ]
      : []),
    ...(canCredential
      ? [
          {
            icon: <KeyRound aria-hidden="true" size={16} />,
            label: "Login permission",
            value: "credential",
          },
        ]
      : []),
    ...(agentNote.omission !== undefined &&
    agentNote.remedy !== undefined &&
    props.onAgentBrowserRecovery !== undefined
      ? [
          {
            description: agentNote.message,
            icon: <Globe2 aria-hidden="true" size={16} />,
            label: agentNote.remedy,
            value: "recover",
          },
        ]
      : []),
    ...(props.onDockResearch === undefined || props.tab.threadId === undefined
      ? []
      : [
          {
            icon: <PanelRight aria-hidden="true" size={16} />,
            label: "Dock in the focus zone",
            value: "dock",
          },
        ]),
    ...(activeContext
      ? [
          {
            icon: <X aria-hidden="true" size={16} />,
            label: "Stop this Browser session",
            value: "stop",
          },
        ]
      : []),
  ];
  function runMoreItem(value: string): void {
    switch (value) {
      case "take-over":
      case "hand-back":
      case "reclaim":
        void holdPage(value === "hand-back" ? "hand-back" : "take-over");
        return;
      case "screenshot":
        void takeScreenshot();
        return;
      case "draw":
        void startMarkup();
        return;
      case "external": {
        const target = validTargetUrl(committedAddress ?? url);
        if (target !== undefined) void props.hostBridge?.openBrowserExternal?.(target);
        return;
      }
      case "credential":
        setCredentialRequest((count) => count + 1);
        return;
      case "recover":
        if (agentNote.omission !== undefined) props.onAgentBrowserRecovery?.(agentNote.omission);
        return;
      case "dock":
        if (props.tab.threadId !== undefined) {
          props.onDockResearch?.({ threadId: String(props.tab.threadId), mode: props.tab.mode });
        }
        return;
      case "stop":
        void stop(false);
        return;
    }
  }

  return (
    <section
      aria-label="Browser automation"
      className={`browser-workspace${notice === undefined ? "" : " browser-workspace--message"}${showFeedback ? " browser-workspace--feedback" : ""}`}
    >
      <OctantDialogPresence>
        {pendingTaskProfile === undefined ? null : (
          <OctantConfirmDialog
            title="Change this task’s default Browser profile?"
            confirmLabel="Change profile"
            pending={selectingTaskProfile}
            onCancel={() => setPendingTaskProfile(undefined)}
            onConfirm={() => void selectTaskProfile(pendingTaskProfile)}
          >
            The current address opens in a fresh page in the chosen profile. Unsaved form entries on
            this page will be lost. Your task, conversation, and message draft stay open. The
            original page stays open if the switch fails.
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
      <header
        className="browser-workspace__chrome"
        ref={chrome}
        {...(activeContext ? { "data-page": "open" } : {})}
      >
        <OctantIconButton
          disabled={!nativeContext || !nativeState?.canGoBack}
          label="Back"
          onClick={() => nativeCommand("back")}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={!nativeContext || !nativeState?.canGoForward}
          label="Forward"
          onClick={() => nativeCommand("forward")}
          type="button"
        >
          <ArrowRight aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={!activeContext}
          label={nativeState?.loading ? "Stop loading" : "Reload"}
          onClick={() => {
            if (nativeContext) {
              nativeCommand(nativeState?.loading ? "stop" : "reload");
            } else if (!nativeState?.loading) {
              // Reload must use the committed page, not an unsubmitted omnibox draft.
              const target = committedAddress ?? validTargetUrl(url);
              if (target !== undefined) {
                void act("navigate", { target });
              }
            }
          }}
          type="button"
        >
          {nativeState?.loading ? (
            <X aria-hidden="true" size={16} />
          ) : (
            <RotateCw aria-hidden="true" size={16} />
          )}
        </OctantIconButton>
        <div className="browser-workspace__field">
          <span className="browser-workspace__lead">
            <BrowserProfileControl
              accounts={accounts}
              disabled={
                starting ||
                selectingTaskProfile ||
                (taskProfileSupported && !props.startFresh && taskProfileRead !== "ready")
              }
              iconOnly
              {...(taskProfileApplies ? { label: "Default browser profile for this task" } : {})}
              onChange={(choice) => void chooseProfile(choice)}
              profile={
                taskProfileApplies
                  ? (taskProfile?.profile ?? "private")
                  : activeContext
                    ? profileChoiceOf(storedProfileOf(snapshot?.context?.policy.profile))
                    : profileChoice
              }
              projectProfileAvailable
              signedInPagesAvailable={nativeSupported}
              {...(taskProfileApplies || props.client.manageProfiles === undefined
                ? {}
                : { onSignOut: () => signOutOfProfile() })}
            />
            <span
              aria-label={addressSecurityLabel}
              className="browser-workspace__mark"
              role="img"
              title={
                committedAddress === undefined
                  ? "Enter an HTTP or HTTPS address"
                  : secureAddress
                    ? "Secure HTTPS connection"
                    : "HTTP connection is not secure"
              }
            >
              {secureAddress ? (
                <LockKeyhole aria-hidden="true" size={14} />
              ) : (
                <Globe2 aria-hidden="true" size={14} />
              )}
            </span>
            <span
              aria-label={statusText}
              className="browser-workspace__mark"
              role="img"
              title={statusText}
            >
              {nativeState?.loading || nativeState?.control === "agent" ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="browser-workspace__control-spinner"
                  size={14}
                />
              ) : (
                <Eye aria-hidden="true" size={14} />
              )}
            </span>
          </span>
          <form
            className="browser-workspace__omnibox"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void navigate();
            }}
          >
            <span className="browser-workspace__address">
              <OctantInput
                aria-label="Browser URL"
                onChange={(event) => {
                  setAddressTyped(true);
                  setUrl(event.target.value);
                }}
                placeholder="Enter an address"
                spellCheck={false}
                type="text"
                unstyled
                value={url}
              />
              <MiddleTruncatedText
                ariaHidden
                className="browser-workspace__address-preview"
                value={url}
              />
            </span>
          </form>
        </div>
        {holdAction === undefined || foldHold ? null : (
          <OctantIconButton
            label={holdAction.label}
            onClick={() => void holdPage(holdAction.hold)}
            title={holdAction.title}
            type="button"
          >
            {holdAction.hold === "hand-back" ? (
              <Undo2 aria-hidden="true" size={16} />
            ) : (
              <Hand aria-hidden="true" size={16} />
            )}
          </OctantIconButton>
        )}
        {nativeContext && activeContext ? (
          <BrowserExtensionsButton
            agentDriving={nativeState?.control === "agent"}
            client={props.client}
            hostBridge={props.hostBridge}
            profile={storedProfileOf(snapshot?.context?.policy.profile)}
            refreshKey={
              snapshot?.context === undefined ? undefined : String(snapshot.context.contextId)
            }
            {...(props.onManageExtensions === undefined
              ? {}
              : { onManage: props.onManageExtensions })}
          />
        ) : null}
        {moreItems.length === 0 ? null : (
          <span className="browser-workspace__more" ref={moreAnchor}>
            <OctantMenu
              items={moreItems}
              onValueChange={(value) => runMoreItem(value)}
              selectionMode="action"
              trigger={<Ellipsis aria-hidden="true" size={16} />}
              triggerClassName={`${octantButtonClassName({ variant: "ghost", size: "icon" })} shell-icon-button`}
              triggerLabel="More Browser actions"
              triggerTitle="More Browser actions"
              value=""
            />
          </span>
        )}
        {nativeContext &&
        activeContext &&
        snapshot?.context !== undefined &&
        (snapshot.context.authority.mode === "work" ||
          snapshot.context.authority.mode === "code") ? (
          <BrowserCredentialBindingControl
            key={String(snapshot.context.contextId)}
            client={props.client}
            context={{
              contextId: snapshot.context.contextId,
              threadId: snapshot.context.threadId,
              mode: snapshot.context.authority.mode,
            }}
            held={snapshot.waitingForPerson !== undefined}
            openRequest={credentialRequest}
            profile={snapshot.context.policy.profile ?? { kind: "private" }}
            restoreFocus={moreTrigger}
          />
        ) : null}
        <span aria-live="polite" className="sr-only">
          <span>{statusLabel(status)}</span>
          {snapshot?.observation?.title === undefined ? null : (
            <span>{snapshot.observation.title}</span>
          )}
          {agentDriving ? null : <span>{agentNote.message}</span>}
        </span>
      </header>
      {taskProfileSupported && !props.startFresh && taskProfileRead === "error" ? (
        <OctantAlert tone="warning">
          The task’s default could not be loaded. Its saved choice has not changed.
          <OctantButton
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setTaskProfileReadState(undefined);
              setTaskProfileRetry((value) => value + 1);
            }}
          >
            Retry task default
          </OctantButton>
          {!activeContext ? (
            <OctantButton
              type="button"
              size="sm"
              variant="secondary"
              disabled={starting || url.trim() === ""}
              onClick={() => void start(url, undefined, "private", true)}
            >
              Open Private page
            </OctantButton>
          ) : null}
        </OctantAlert>
      ) : null}
      {notice === undefined ? null : (
        <OctantAlert
          className={
            message === undefined && captureNoticeTone !== "warning"
              ? "browser-workspace__notice"
              : "browser-workspace__message"
          }
          tone={message === undefined ? captureNoticeTone : "warning"}
        >
          {notice}
        </OctantAlert>
      )}
      {!activeContext ? (
        <div className="browser-workspace__start">
          {serverSuggestions.length > 0 ? (
            <section aria-label="Local servers" className="browser-workspace__local">
              <header className="browser-workspace__local-header">
                <h2>Local</h2>
                <OctantButton
                  aria-label="Refresh local servers"
                  onClick={() => void localServers.refresh()}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <RotateCw aria-hidden="true" size={14} />
                </OctantButton>
              </header>
              <ul aria-label="Running servers" className="browser-workspace__servers">
                {serverSuggestions.map((server) => {
                  const kind = server.framework ?? server.processName;
                  const name = server.workspaceLabel ?? kind;
                  const address = serverAddressLabel(server.url);
                  return (
                    <li className="browser-workspace__server-row" key={server.listenerId}>
                      <OctantButton
                        aria-label={`Open ${name} at ${address}`}
                        disabled={starting}
                        onClick={() => void openServer(server)}
                        type="button"
                        variant="ghost"
                      >
                        <span className="browser-workspace__server">
                          <span className="browser-workspace__server-text">
                            <span className="browser-workspace__server-name">{name}</span>
                            <span className="browser-workspace__server-meta">
                              <span className="browser-workspace__server-address">{address}</span>
                              {name === kind ? null : <span>{` · ${kind}`}</span>}
                            </span>
                          </span>
                          {/* Every listed server answered the host's probe, so the
                              dot marks it running rather than telling rows apart. */}
                          <span aria-hidden="true" className="browser-workspace__server-dot" />
                        </span>
                      </OctantButton>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {recentSuggestions.length > 0 ? (
            <section aria-label="Recent pages" className="browser-workspace__local">
              <header className="browser-workspace__local-header">
                <h2>Recent</h2>
              </header>
              <ul aria-label="Recently opened pages" className="browser-workspace__servers">
                {recentSuggestions.map((page) => {
                  const address = serverAddressLabel(page.url);
                  const host = new URL(page.url).host;
                  return (
                    <li className="browser-workspace__server-row" key={page.url}>
                      <OctantButton
                        aria-label={`Open ${address}`}
                        disabled={starting}
                        onClick={() => {
                          setAddressTyped(true);
                          void start(page.url);
                        }}
                        type="button"
                        variant="ghost"
                      >
                        <span className="browser-workspace__server">
                          <Globe2
                            aria-hidden="true"
                            className="browser-workspace__recent-icon"
                            size={14}
                          />
                          <span className="browser-workspace__server-text">
                            <span className="browser-workspace__server-name">{host}</span>
                            {address === host ? null : (
                              <span className="browser-workspace__server-meta">
                                <span className="browser-workspace__server-address">{address}</span>
                              </span>
                            )}
                          </span>
                        </span>
                      </OctantButton>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {serverSuggestions.length > 0 || recentSuggestions.length > 0 ? (
            <p className="browser-workspace__local-note">
              A page opens isolated to this thread and shared with its agent.
            </p>
          ) : (
            <div className="browser-workspace__empty">
              <ShieldCheck aria-hidden="true" size={20} />
              <h2>Open a private Browser session</h2>
              <p>The page is isolated to this thread and shared with its agent.</p>
              <OctantButton
                aria-label="Start browser"
                disabled={starting || url.trim() === ""}
                onClick={() => void startFromAddress()}
                type="button"
              >
                {starting ? "Starting…" : "Open page"}
              </OctantButton>
            </div>
          )}
        </div>
      ) : nativeContext ? (
        <div
          aria-label="Live Chromium page"
          className="browser-workspace__native"
          ref={nativeSurface.mount}
        >
          {nativeSurface.embedded}
          {markupPicture === undefined ? null : (
            <BrowserMarkupStage
              dataUrl={markupPicture}
              notice={markupNotice}
              onAddToChat={addMarkupToMessage}
              onClose={closeMarkup}
            />
          )}
          {nativeSurface.failed ? (
            <OctantAlert className="browser-workspace__native-error" tone="danger">
              <p>The live Chromium page could not attach to this pane.</p>
              <OctantButton onClick={nativeSurface.retry} type="button" variant="secondary">
                Retry
              </OctantButton>
            </OctantAlert>
          ) : null}
        </div>
      ) : markupPicture !== undefined ? (
        // The headless preview's click-through handlers are not mounted while
        // the picture is drawn on, so a stroke can never click the page.
        <div className="browser-workspace__markup-page">
          <BrowserMarkupStage
            dataUrl={markupPicture}
            notice={markupNotice}
            onAddToChat={addMarkupToMessage}
            onClose={closeMarkup}
          />
        </div>
      ) : (
        <article
          aria-label="Interactive headless Browser preview"
          className={`browser-workspace__remote${remoteFocused ? " browser-workspace__remote--focused" : ""}`}
          onBlur={() => setRemoteFocused(false)}
          onFocus={() => setRemoteFocused(true)}
          onKeyDown={(event) => {
            if (!remoteFocused || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key.length === 1) {
              event.preventDefault();
              queueRemoteAction("type", { value: event.key });
              return;
            }
            const key = event.shiftKey && event.key === "Tab" ? "Shift+Tab" : event.key;
            if (!SUPPORTED_REMOTE_KEYS.has(key)) return;
            event.preventDefault();
            queueRemoteAction("press", { value: key });
          }}
          onWheel={(event) => {
            event.preventDefault();
            queueRemoteAction("scroll", {
              deltaX: boundedWheelDelta(event.deltaX),
              deltaY: boundedWheelDelta(event.deltaY),
            });
          }}
          role="application"
          tabIndex={0}
        >
          {snapshot?.observation?.screenshotDataUrl === undefined ? (
            <div className="browser-workspace__remote-empty">
              <p>Waiting for the host to capture this page.</p>
              <OctantButton
                onClick={() => void act("screenshot")}
                type="button"
                variant="secondary"
              >
                Refresh preview
              </OctantButton>
            </div>
          ) : (
            <img
              alt={`${snapshot.observation.title ?? "Current page"} browser preview`}
              className="browser-workspace__preview"
              draggable={false}
              onClick={(event) => {
                const point = previewPoint(event.currentTarget, event.clientX, event.clientY);
                if (point === undefined) return;
                if (feedbackPointing.pointing) {
                  feedbackPointing.headlessPoint(point, snapshot.observation?.revision);
                  return;
                }
                event.currentTarget.parentElement?.focus();
                queueRemoteAction("click", { point });
              }}
              src={snapshot.observation.screenshotDataUrl}
            />
          )}
        </article>
      )}
      {!showFeedback ? null : (
        <ProductFeedbackPanel
          key={`${props.tab.mode}:${props.tab.threadId}`}
          busy={feedback.busy}
          pending={feedback.pending}
          crops={feedback.crops}
          preview={feedback.preview}
          previewExpired={feedback.previewExpired}
          {...(feedbackNotice === undefined ? {} : { message: feedbackNotice })}
          {...(feedbackSelectionUnavailable === undefined
            ? {}
            : { selectionUnavailable: feedbackSelectionUnavailable })}
          pointing={feedbackPointing.pointing}
          onTogglePointing={feedbackPointing.toggle}
          onCancel={() => {
            feedbackPointing.cancel();
            void feedback.cancel();
          }}
          onSubmit={feedback.commit}
          onUpdate={feedback.update}
          onDiscard={(note) => void feedback.discard(note)}
          onRefresh={() => void feedback.refresh()}
        />
      )}
    </section>
  );
}

const SUPPORTED_REMOTE_KEYS = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function previewPoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): BrowserViewportPoint | undefined {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return undefined;
  }
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const contentWidth = image.naturalWidth * scale;
  const contentHeight = image.naturalHeight * scale;
  const offsetX = (rect.width - contentWidth) / 2;
  const offsetY = 0;
  const x = clientX - rect.left - offsetX;
  const y = clientY - rect.top - offsetY;
  if (x < 0 || y < 0 || x > contentWidth || y > contentHeight) return undefined;
  return { x: x / contentWidth, y: y / contentHeight } as BrowserViewportPoint;
}

function boundedWheelDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-2000, Math.min(2000, Math.round(value)));
}

/**
 * Servers worth opening, this checkout's first. A listener the host could not
 * reach is left out: it would open onto an error page.
 */
function openableServers(snapshot: LocalServerSnapshot): LocalServerSnapshot["currentCheckout"] {
  const seen = new Set<string>();
  return [...snapshot.currentCheckout, ...snapshot.other].filter((server) => {
    if (!server.openAvailable || seen.has(server.url)) return false;
    seen.add(server.url);
    return true;
  });
}

function serverAddressLabel(value: string): string {
  const url = new URL(value);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.host}${path}`;
}

/** The Project or Personal profile a context lives in, if it is in one. */
function storedProfileOf(profile: BrowserProfile | undefined): StoredBrowserProfile | undefined {
  return profile === undefined || profile.kind === "private" ? undefined : profile;
}

function storedProfileFor(
  choice: BrowserProfileChoice,
  projectId: ProjectId | undefined,
): StoredBrowserProfile | undefined {
  return storedProfileOf(browserProfileFromChoice(choice, projectId));
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Browser supports HTTP and HTTPS addresses only.");
  }
  return url.toString();
}

function snapshotRevision(snapshot: BrowserAutomationSnapshot | undefined): string {
  if (snapshot === undefined) return "none";
  return JSON.stringify([
    snapshot.status,
    snapshot.agentAvailability,
    snapshot.context?.contextId,
    snapshot.context?.state,
    snapshot.context?.presentation,
    snapshot.waitingForPerson,
    snapshot.observation?.revision,
    snapshot.observation?.observedAt,
    snapshot.observation?.contentHash,
    snapshot.observation?.url,
    snapshot.evidence.length,
    snapshot.failure?.category,
    snapshot.failure?.message,
  ]);
}

function browserRefreshDelay(unchangedCount: number): number {
  return Math.min(
    BROWSER_MAX_REFRESH_INTERVAL_MS,
    BROWSER_REFRESH_INTERVAL_MS * 2 ** Math.min(unchangedCount, 4),
  );
}

function makeAction(scope: BrowserThreadScope): ToolActionRequest {
  return makeBrowserToolAction(scope, "Open and operate one host-owned isolated browser context.");
}

/** One tool-action envelope for a host-owned Browser request under `scope`. */
export function makeBrowserToolAction(
  scope: BrowserThreadScope,
  intent: string,
): ToolActionRequest {
  return {
    actionId: crypto.randomUUID() as ToolActionRequest["actionId"],
    correlationId: crypto.randomUUID() as ToolActionRequest["correlationId"],
    capability: { id: "browser-automation" as ToolActionRequest["capability"]["id"], version: 1 },
    authority: scope.authority,
    intent,
    approval: { kind: "not-required" },
  };
}

function statusLabel(status: BrowserWorkspaceStatus): string {
  return `Browser ${status}`;
}

function captureNotKeptNotice(
  reason: BrowserCaptureNotKeptReason,
  purpose: "screenshot" | "drawing" = "screenshot",
): string {
  const why: Record<BrowserCaptureNotKeptReason, string> = {
    "too-large": "the picture is too large",
    "not-an-image": "the host did not recognise it as an image",
    "no-page-origin": "the page has no web address",
    "no-picture": "the Browser gave no picture of this page",
    unavailable: "the host could not store it",
  };
  if (purpose === "drawing") {
    // Draw on page keeps a screenshot to draw on, so the words say what is missing.
    return reason === "no-picture"
      ? "There is nothing to draw on: the Browser gave no picture of this page. A page with a sign-in field is never pictured."
      : `There is nothing to draw on: the screenshot could not be kept, because ${why[reason]}.`;
  }
  return `This screenshot could not be kept: ${why[reason]}.`;
}

function applyFailure(
  error: unknown,
  setStatus: (status: BrowserWorkspaceStatus) => void,
  setMessage: (message: string | undefined) => void,
): void {
  if (error instanceof BrowserAutomationClientFailure) {
    setStatus(
      error.category === "interrupted"
        ? "interrupted"
        : error.category === "unavailable"
          ? "unavailable"
          : error.category === "stale"
            ? "stale"
            : "failed",
    );
    setMessage(
      error.category === "stale"
        ? "That page has closed, for example when Octant restarted. Open it again from Recent or the address bar."
        : error.message,
    );
    return;
  }
  setStatus("failed");
  setMessage("Browser automation failed closed.");
}
