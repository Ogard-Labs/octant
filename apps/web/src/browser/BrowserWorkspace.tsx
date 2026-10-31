import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserAutomationSnapshot,
  BrowserThreadScope,
  BrowserWorkspaceStatus,
} from "@octant/contracts/browser-automation-rpc";
import type {
  BrowserActionKind,
  BrowserActionRequest,
  BrowserCaptureNotKeptReason,
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
  LoaderCircle,
  LockKeyhole,
  PanelRight,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MiddleTruncatedText } from "../lib/MiddleTruncatedText";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ShellState } from "../shell/ShellState";
import { ProductFeedbackPanel } from "./ProductFeedbackPanel";
import { useProductFeedback } from "./useProductFeedback";
import type { OctantHostBridge } from "../shell/hostBridge";
import { useNativeBrowserSurface } from "./useNativeBrowserSurface";
import { OctantAlert } from "../ui/base/OctantAlert";
import { useLocalServersController } from "../environment/useLocalServersController";
import { readRecentBrowserPages, recordRecentBrowserPage } from "./recentBrowserPages";
import { BrowserProfileControl } from "./BrowserProfileControl";
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
  ".rail-placeholder",
  ".workspace-drag-preview",
  ".workspace-drop-overlay",
  ".octant-dialog__backdrop",
  ".octant-dialog__viewport",
  ".octant-dialog__popup",
].join(", ");

const BROWSER_REFRESH_INTERVAL_MS = 500;
const BROWSER_MAX_REFRESH_INTERVAL_MS = 5_000;

export interface BrowserWorkspaceProps {
  readonly client: BrowserAutomationClient;
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
  /** A newly added Browser tab must not attach to another tab's current context. */
  readonly startFresh?: boolean;
}

export function BrowserWorkspace(props: BrowserWorkspaceProps) {
  const [url, setUrl] = useState("");
  // A server suggestion fills the address only until the person types one.
  const [addressTyped, setAddressTyped] = useState(false);
  const [scope, setScope] = useState<BrowserThreadScope>();
  const [snapshot, setSnapshot] = useState<BrowserAutomationSnapshot>();
  const [status, setStatus] = useState<BrowserWorkspaceStatus>(
    props.tab.threadId === undefined ? "unavailable" : "ready",
  );
  const [message, setMessage] = useState<string>();
  // A capture the host declined to keep is said once, apart from `message`,
  // because every poll of the page rewrites `message`.
  const [captureNotice, setCaptureNotice] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ownedContextId, setOwnedContextId] = useState<BrowserContextId | undefined>(
    props.tab.contextId,
  );
  const [nativeSupported, setNativeSupported] = useState(false);
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
  const [pointing, setPointing] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<BrowserViewportPoint>();
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
  const controlLabel = !nativeContext
    ? "Preview"
    : nativeSurface.failed
      ? "Live page unavailable"
      : nativeState?.control === "agent"
        ? "Agent active"
        : nativeState?.control === "user"
          ? "You control"
          : "Shared live page";

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
    if (props.startFresh === true && contextId === undefined) {
      setStatus("ready");
      return;
    }
    const controller = new AbortController();
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus("waiting");
    const refresh = async () => {
      let nextDelay = BROWSER_REFRESH_INTERVAL_MS;
      try {
        // A tab opened for one host-owned context shows that context and no
        // other: asking for the thread's current context instead
        // would move this tab onto whatever was opened last.
        const next =
          contextId === undefined
            ? await props.client.inspectThread({ threadId: props.tab.threadId! }, controller.signal)
            : await props.client.inspect(
                { contextId, threadId: props.tab.threadId! },
                controller.signal,
              );
        if (!active || controller.signal.aborted) return;
        const revision = snapshotRevision(next);
        const changed = revision !== lastPolledRevision.current;
        lastPolledRevision.current = revision;
        unchangedPolls.current = changed ? 0 : unchangedPolls.current + 1;
        nextDelay = browserRefreshDelay(unchangedPolls.current);
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
    choice: BrowserProfileChoice = profileChoice,
  ): Promise<void> {
    if (startInFlight.current) return;
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
   */
  async function takeScreenshot(): Promise<void> {
    const takeCapture = props.client.takeCapture;
    if (
      snapshot?.context === undefined ||
      scope === undefined ||
      props.tab.threadId === undefined ||
      takeCapture === undefined
    ) {
      return;
    }
    localFailure.current = false;
    setCapturing(true);
    setCaptureNotice(undefined);
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
      if (next.observation?.capture?.status === "not-kept") {
        setCaptureNotice(captureNotKeptNotice(next.observation.capture.reason));
      }
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    } finally {
      setCapturing(false);
    }
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
  async function chooseProfile(choice: BrowserProfileChoice): Promise<void> {
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

  return (
    <section
      aria-label="Browser automation"
      className={`browser-workspace${notice === undefined ? "" : " browser-workspace--message"}`}
    >
      <header className="browser-workspace__chrome">
        <div className="browser-workspace__history" aria-label="Browser history controls">
          <OctantButton
            aria-label="Back"
            className="browser-workspace__history-button"
            disabled={!nativeContext || !nativeState?.canGoBack}
            onClick={() => nativeCommand("back")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            aria-label="Forward"
            className="browser-workspace__history-button"
            disabled={!nativeContext || !nativeState?.canGoForward}
            onClick={() => nativeCommand("forward")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowRight aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            aria-label={nativeState?.loading ? "Stop loading" : "Reload"}
            className="browser-workspace__history-button"
            disabled={!activeContext}
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
            size="icon"
            type="button"
            variant="ghost"
          >
            {nativeState?.loading ? (
              <X aria-hidden="true" size={14} />
            ) : (
              <RotateCw aria-hidden="true" size={14} />
            )}
          </OctantButton>
        </div>
        <BrowserProfileControl
          disabled={starting}
          onChange={(choice) => void chooseProfile(choice)}
          profile={
            activeContext
              ? profileChoiceOf(storedProfileOf(snapshot?.context?.policy.profile))
              : profileChoice
          }
          projectProfileAvailable
          signedInPagesAvailable={nativeSupported}
          {...(props.client.manageProfiles === undefined
            ? {}
            : { onSignOut: () => signOutOfProfile() })}
        />
        <form
          className="browser-workspace__omnibox"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <span
            aria-label={addressSecurityLabel}
            className="browser-workspace__security"
            title={
              committedAddress === undefined
                ? "Enter an HTTP or HTTPS address"
                : secureAddress
                  ? "Secure HTTPS connection"
                  : "HTTP connection is not secure"
            }
          >
            {secureAddress ? (
              <LockKeyhole aria-hidden="true" size={12} />
            ) : (
              <Globe2 aria-hidden="true" size={12} />
            )}
          </span>
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
              value={url}
            />
            <MiddleTruncatedText
              ariaHidden
              className="browser-workspace__address-preview"
              value={url}
            />
          </span>
        </form>
        <span
          className="browser-workspace__control-state"
          title={
            nativeContext
              ? "You and the agent share this live Chromium page."
              : "Click, type, and scroll this headless page through the shared Browser context."
          }
        >
          {nativeState?.loading || nativeState?.control === "agent" ? (
            <LoaderCircle aria-hidden="true" size={12} />
          ) : null}
          {controlLabel}
        </span>
        {activeContext && props.client.takeCapture !== undefined ? (
          <OctantButton
            aria-label="Screenshot"
            className="browser-workspace__close"
            disabled={capturing}
            onClick={() => void takeScreenshot()}
            size="icon"
            title="Screenshot (kept with this thread)"
            type="button"
            variant="ghost"
          >
            <Camera aria-hidden="true" size={14} />
          </OctantButton>
        ) : null}
        {activeContext ? (
          props.hostBridge?.openBrowserExternal === undefined ? null : (
            <OctantButton
              aria-label="Open in default browser"
              className="browser-workspace__close"
              onClick={() => {
                const target = validTargetUrl(committedAddress ?? url);
                if (target !== undefined) void props.hostBridge!.openBrowserExternal!(target);
              }}
              size="icon"
              title="Open in default browser"
              type="button"
              variant="ghost"
            >
              <ExternalLink aria-hidden="true" size={14} />
            </OctantButton>
          )
        ) : null}
        {props.onDockResearch === undefined || props.tab.threadId === undefined ? null : (
          <OctantButton
            aria-label="Dock in the focus zone"
            className="browser-workspace__close"
            onClick={() =>
              props.onDockResearch?.({
                threadId: String(props.tab.threadId),
                mode: props.tab.mode,
              })
            }
            size="icon"
            title="Dock in the focus zone"
            type="button"
            variant="ghost"
          >
            <PanelRight aria-hidden="true" size={14} />
          </OctantButton>
        )}
        {activeContext ? (
          <OctantButton
            aria-label="Stop"
            className="browser-workspace__close"
            onClick={() => void stop(false)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} />
          </OctantButton>
        ) : null}
        <span aria-live="polite" className="sr-only">
          <span>{statusLabel(status)}</span>
          {snapshot?.observation?.title === undefined ? null : (
            <span>{snapshot.observation.title}</span>
          )}
        </span>
      </header>
      {notice === undefined ? null : (
        <OctantAlert className="browser-workspace__message" tone="warning">
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
          {nativeSurface.failed ? (
            <OctantAlert className="browser-workspace__native-error" tone="danger">
              <p>The live Chromium page could not attach to this pane.</p>
              <OctantButton onClick={nativeSurface.retry} type="button" variant="secondary">
                Retry
              </OctantButton>
            </OctantAlert>
          ) : null}
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
                if (pointing) {
                  // Marking a spot never touches the page: the host is asked
                  // what is there only once the user has written the note.
                  setPendingPoint(point);
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
      {!feedback.available || snapshot?.context === undefined ? null : (
        <ProductFeedbackPanel
          busy={feedback.busy}
          {...(feedback.message === undefined ? {} : { message: feedback.message })}
          onCancel={() => setPendingPoint(undefined)}
          onDiscard={(note) => void feedback.discard(note)}
          onSubmit={(comment) => {
            const point = pendingPoint;
            const contextId = snapshot.context?.contextId;
            if (point === undefined || contextId === undefined) return;
            void (async () => {
              const captured = await feedback.capture({
                contextId: String(contextId),
                point,
                comment,
              });
              if (captured) {
                setPendingPoint(undefined);
                setPointing(false);
              }
            })();
          }}
          onTogglePointing={() => {
            setPointing((current) => !current);
            setPendingPoint(undefined);
          }}
          pending={feedback.pending}
          {...(pendingPoint === undefined ? {} : { pendingPoint })}
          pointing={pointing}
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
  if (choice === "personal") return { kind: "personal" };
  if (choice === "project" && projectId !== undefined) return { kind: "project", projectId };
  return undefined;
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
    snapshot.context?.contextId,
    snapshot.context?.state,
    snapshot.context?.presentation,
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

function captureNotKeptNotice(reason: BrowserCaptureNotKeptReason): string {
  const why: Record<BrowserCaptureNotKeptReason, string> = {
    "too-large": "the picture is too large",
    "not-an-image": "the host did not recognise it as an image",
    "no-page-origin": "the page has no web address",
    "no-picture": "the Browser gave no picture of this page",
    unavailable: "the host could not store it",
  };
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
