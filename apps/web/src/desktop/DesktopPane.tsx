import type {
  DesktopFrameAnswer,
  DesktopPaneClient,
} from "@octant/client-runtime/desktop-pane-client";
import type {
  DesktopInputEvent,
  DesktopLease,
  DesktopLeaseId,
  DesktopMachine,
  DesktopPaneAnswer,
  DesktopPaneRequest,
  DesktopPaneStart,
  DesktopPlacementId,
  DesktopViewId,
  LeasableDesktopProvider,
} from "@octant/contracts";
import { decodeDesktopPaneRequest } from "@octant/contracts";
import { Clock, Monitor, Power, RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DeviceLine } from "../device/DeviceLine";
import { DeviceSpinner } from "../device/DeviceStage";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import {
  desktopDollars,
  desktopHours,
  desktopKeyIntent,
  desktopPaneState,
  desktopWhere,
  endedMessage,
  extensionMinutes,
  providerName,
  runningDesktops,
  screenPoint,
  selectedDesktop,
  startRefusalMessage,
  type DesktopOverview,
  type DesktopPaneState,
} from "./desktopPaneModel";

/** How often the pane asks for a frame while it is on screen, and while the window is hidden. */
const FRAME_INTERVAL_MS = 250;
const HIDDEN_FRAME_INTERVAL_MS = 10_000;
/** How often the pane re-reads the thread's leases, so an expiry or a release shows. */
const OVERVIEW_INTERVAL_MS = 3_000;
/** Frames in a row the host may answer without a picture before the view counts as lost. */
const MISSED_FRAMES_BEFORE_LOST = 4;
/** Typed characters wait this long for the next one, so a word crosses as one input. */
const TEXT_FLUSH_MS = 80;
/** Wheel movement is gathered this long into one scroll. */
const SCROLL_FLUSH_MS = 100;

interface OpenView {
  readonly leaseId: DesktopLeaseId;
  readonly viewId: DesktopViewId;
}

/** The provider, placement, and machine a person is asked to confirm before a desktop starts. */
interface StartToConfirm {
  readonly provider: LeasableDesktopProvider;
  readonly placementId?: DesktopPlacementId;
  readonly machine?: DesktopMachine;
  /** For a billed desktop: its estimate and this month's spend against the cap. */
  readonly spend?: Extract<DesktopPaneStart, { readonly status: "available" }>["spend"];
}

/** What this tab holds of one lease's screen in this window session. */
type Shown =
  | { readonly leaseId: DesktopLeaseId; readonly presence: "opening" | "lost" | "readable" }
  | { readonly leaseId: DesktopLeaseId; readonly presence: "open"; readonly view: OpenView };

/**
 * A Code thread's disposable desktops in the dock. The host decides every
 * state; this pane shows it and carries the person's input. A tab shows a
 * screen only after the person starts a desktop here or presses Show desktop:
 * a tab restored from a saved layout or a reload never reconnects on its own,
 * and the host holds no view across a restart to reconnect to.
 */
export function DesktopPane(props: {
  readonly client: DesktopPaneClient;
  readonly threadId: string;
  readonly now?: () => number;
}) {
  const { client, threadId } = props;
  const now = props.now ?? Date.now;
  const [overview, setOverview] = useState<DesktopOverview>();
  const [failure, setFailure] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [acquiring, setAcquiring] = useState(false);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmStart, setConfirmStart] = useState<StartToConfirm>();
  const [shown, setShown] = useState<Shown>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ask = useCallback(
    (request: DesktopPaneRequest) => client.request(decodeDesktopPaneRequest(request)),
    [client],
  );

  const refresh = useCallback(async () => {
    try {
      const answer = await ask({ kind: "overview", threadId });
      if (!mounted.current) return;
      if (answer.status === "overview") {
        setOverview(answer);
        setFailure(undefined);
      } else if (answer.status === "refused") {
        setOverview(undefined);
        setFailure(startRefusalMessage(answer.reason));
      }
    } catch {
      if (mounted.current) setFailure("The host could not be reached.");
    }
  }, [ask, threadId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, OVERVIEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const selected = overview === undefined ? undefined : selectedDesktop(overview, chosen);
  const state = desktopPaneState({
    overview,
    ...(failure === undefined ? {} : { failure }),
    ...(chosen === undefined ? {} : { chosen }),
    acquiring,
    view:
      shown !== undefined &&
      selected !== undefined &&
      String(shown.leaseId) === String(selected.leaseId)
        ? shown.presence
        : "none",
  });
  const view = shown?.presence === "open" ? shown.view : undefined;

  const closeView = useCallback(
    (closing: OpenView | undefined) => {
      if (closing === undefined) return;
      void ask({ kind: "close-view", threadId, ...closing }).catch(() => undefined);
    },
    [ask, threadId],
  );

  // A view belongs to this mount. Unmounting closes it, so a tab that went
  // away holds idle release off no longer than the host's own lapse.
  const viewRef = useRef<OpenView>(undefined);
  viewRef.current = view;
  useEffect(() => () => closeView(viewRef.current), [closeView]);

  const hide = useCallback(() => {
    closeView(viewRef.current);
    viewRef.current = undefined;
    setShown(undefined);
  }, [closeView]);

  const show = useCallback(
    async (leaseId: DesktopLeaseId) => {
      hide();
      setShown({ leaseId, presence: "opening" });
      setChosen(String(leaseId));
      const answer = await ask({ kind: "open-view", threadId, leaseId }).catch(() => undefined);
      if (!mounted.current) {
        if (answer?.status === "viewing") closeView({ leaseId, viewId: answer.viewId });
        return;
      }
      if (answer?.status === "viewing") {
        setShown({ leaseId, presence: "open", view: { leaseId, viewId: answer.viewId } });
        setNotice(undefined);
        return;
      }
      // The stage says why in full; a notice would only repeat it.
      if (answer?.status === "refused" && answer.reason === "session-readable") {
        setShown({ leaseId, presence: "readable" });
        setNotice(undefined);
        return;
      }
      setShown({ leaseId, presence: "lost" });
      setNotice(
        answer?.status === "refused"
          ? startRefusalMessage(answer.reason)
          : "The host could not be reached.",
      );
      void refresh();
    },
    [ask, closeView, hide, refresh, threadId],
  );

  const act = useCallback(
    async (label: string, request: DesktopPaneRequest): Promise<DesktopPaneAnswer | undefined> => {
      setPending(label);
      try {
        const answer = await ask(request);
        if (answer.status === "refused") setNotice(startRefusalMessage(answer.reason));
        return answer;
      } catch {
        setNotice("The host could not be reached.");
        return undefined;
      } finally {
        if (mounted.current) setPending(undefined);
        void refresh();
      }
    },
    [ask, refresh],
  );

  const start = useCallback(
    async (confirmed?: StartToConfirm) => {
      setConfirmStart(undefined);
      setNotice(undefined);
      setAcquiring(true);
      try {
        const answer = await act("start", {
          kind: "acquire",
          threadId,
          ...(confirmed === undefined ? {} : { confirmedProvider: confirmed.provider.providerId }),
          ...(confirmed?.placementId === undefined
            ? {}
            : { confirmedPlacement: confirmed.placementId }),
          ...(confirmed?.machine === undefined
            ? {}
            : { confirmedMachine: confirmed.machine.machineId }),
        });
        if (answer?.status === "acquired") await show(answer.lease.leaseId);
        else if (answer?.status === "not-acquired") {
          setChosen(String(answer.lease.leaseId));
          setNotice("The desktop could not be started.");
        }
      } finally {
        if (mounted.current) setAcquiring(false);
      }
    },
    [act, show, threadId],
  );

  const release = useCallback(
    async (lease: DesktopLease) => {
      setConfirmRelease(false);
      hide();
      await act("release", { kind: "release", threadId, leaseId: lease.leaseId });
    },
    [act, hide, threadId],
  );

  const lost = useCallback(
    (reason?: string) => {
      setShown((current) =>
        current === undefined ? undefined : { leaseId: current.leaseId, presence: "lost" },
      );
      if (reason !== undefined) setNotice(reason);
      void refresh();
    },
    [refresh],
  );

  // The host stopped the open view because the connection could be read.
  const readable = useCallback(() => {
    setShown((current) =>
      current === undefined ? undefined : { leaseId: current.leaseId, presence: "readable" },
    );
    void refresh();
  }, [refresh]);

  const leases = overview === undefined ? [] : runningDesktops(overview);
  const providers = overview?.providers ?? [];
  const where = selected === undefined ? undefined : desktopWhere(providers, selected);
  const title =
    selected === undefined
      ? "Desktop"
      : `${providerName(providers, String(selected.providerId))}${where === undefined ? "" : ` · ${where}`}`;

  return (
    <section aria-label="Desktop" className="device-pane desktop-pane">
      <DesktopToolbar
        leases={leases}
        now={now}
        onExtend={(lease) => {
          const byMinutes = extensionMinutes(lease);
          if (byMinutes > 0) {
            void act("extend", { kind: "extend", threadId, leaseId: lease.leaseId, byMinutes });
          }
        }}
        onRelease={() => setConfirmRelease(true)}
        onSelect={(lease) => {
          if (String(lease.leaseId) === String(selected?.leaseId)) return;
          if (lease.state === "ready") void show(lease.leaseId);
          else {
            hide();
            setChosen(String(lease.leaseId));
          }
        }}
        pending={pending}
        selected={selected}
        state={state}
        title={title}
      />
      {notice === undefined ? null : (
        <DeviceLine
          content={{
            kind: "error",
            problem: { message: notice },
            onDismiss: () => setNotice(undefined),
          }}
        />
      )}
      <div className="device-stage desktop-pane__stage">
        <DesktopStage
          client={client}
          onLost={lost}
          onReadable={readable}
          onRetry={(lease) =>
            void act("retry", { kind: "retry-release", threadId, leaseId: lease.leaseId })
          }
          onShow={(lease) => void show(lease.leaseId)}
          onStart={() => {
            // A billed desktop spends the person's money, and one off this
            // computer runs elsewhere and can outlive it, so they confirm
            // every one here, for the provider, placement, and machine they see.
            const offered = overview?.start.status === "available" ? overview.start : undefined;
            if (
              offered !== undefined &&
              (offered.provider.billed || offered.provider.locality !== "host-local")
            ) {
              setConfirmStart({
                provider: offered.provider,
                ...(offered.placementId === undefined ? {} : { placementId: offered.placementId }),
                ...(offered.machine === undefined ? {} : { machine: offered.machine }),
                ...(offered.spend === undefined ? {} : { spend: offered.spend }),
              });
            } else void start();
          }}
          pending={pending}
          providers={providers}
          state={state}
          threadId={threadId}
          view={view}
        />
      </div>
      {confirmRelease && selected !== undefined ? (
        <OctantConfirmDialog
          confirmLabel="Release"
          destructive
          onCancel={() => setConfirmRelease(false)}
          onConfirm={() => void release(selected)}
          title="Release this desktop?"
        >
          The desktop and everything in it are destroyed. Octant confirms it is gone before it says
          so.
        </OctantConfirmDialog>
      ) : null}
      {confirmStart === undefined ? null : (
        <StartConfirmation
          confirm={confirmStart}
          onCancel={() => setConfirmStart(undefined)}
          onConfirm={() => void start(confirmStart)}
        />
      )}
    </section>
  );
}

/**
 * What a person agrees to before a desktop that bills, or runs off this
 * computer, starts: whose account bills, or which computer it runs on and
 * what is left running there if this computer stops.
 */
function StartConfirmation(props: {
  readonly confirm: StartToConfirm;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { provider, placementId, machine, spend } = props.confirm;
  const placement = provider.placements?.find(
    (entry) => String(entry.placementId) === String(placementId ?? ""),
  );
  const where = placement === undefined ? undefined : placement.displayName;
  if (!provider.billed && machine !== undefined) {
    return (
      <OctantConfirmDialog
        confirmLabel="Start desktop"
        onCancel={props.onCancel}
        onConfirm={props.onConfirm}
        title={`Start a desktop on ${machine.displayName}?`}
      >
        {provider.displayName} runs it on {machine.displayName}
        {where === undefined ? "" : ` (${where})`}, not on this computer, and it does not bill you.
        It ends when you release it or when it expires. If this computer stops, Octant cannot end
        it, and it may keep running there until you delete it in {provider.displayName}.
      </OctantConfirmDialog>
    );
  }
  if (provider.billed) {
    const account =
      where === undefined ? provider.displayName : `${provider.displayName} · ${where}`;
    return (
      <OctantConfirmDialog
        confirmLabel="Start desktop"
        onCancel={props.onCancel}
        onConfirm={props.onConfirm}
        title={`Start a desktop on ${account}?`}
      >
        It runs on your own {account} account, which bills you while it runs. It ends when you
        release it or when it expires, and Octant confirms it is gone.
        {placement?.billedIfHostStopsMinutes === undefined
          ? ""
          : ` If this computer stops, Octant cannot end it, and your account can keep billing for up to ${desktopHours(placement.billedIfHostStopsMinutes)} by its own default, longer if you changed that limit.`}
        {spend === undefined
          ? ""
          : ` By your cost per hour it could cost up to ${desktopDollars(spend.estimateUsdCents)}${
              spend.summary.monthlyCapUsdCents === undefined
                ? ""
                : `; ${desktopDollars(spend.summary.spentUsdCents)} of this month's ${desktopDollars(spend.summary.monthlyCapUsdCents)} cap is already counted`
            }.`}
      </OctantConfirmDialog>
    );
  }
  return (
    <OctantConfirmDialog
      confirmLabel="Start desktop"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
      title="Start a desktop off this computer?"
    >
      {provider.displayName} runs it off this computer
      {where === undefined ? "" : ` (${where})`}, and it does not bill you. It ends when you release
      it or when it expires. If this computer stops, Octant cannot end it, and it may keep running
      there until you delete it in {provider.displayName}.
    </OctantConfirmDialog>
  );
}

function DesktopToolbar(props: {
  readonly title: string;
  readonly state: DesktopPaneState;
  readonly leases: ReadonlyArray<DesktopLease>;
  readonly selected: DesktopLease | undefined;
  readonly pending: string | undefined;
  readonly now: () => number;
  readonly onSelect: (lease: DesktopLease) => void;
  readonly onExtend: (lease: DesktopLease) => void;
  readonly onRelease: () => void;
}) {
  const { state } = props;
  const lease = "lease" in state ? state.lease : undefined;
  const running = lease?.state === "ready";
  const extendable = running && lease !== undefined && extensionMinutes(lease) > 0;
  return (
    <div aria-label="Desktop controls" className="device-toolbar" role="toolbar">
      <span className="device-toolbar__device">
        <span aria-hidden="true" className="device-dot" data-dot={dotFor(state)} />
        <strong className="device-toolbar__name">{props.title}</strong>
      </span>
      <span aria-live="polite" className="device-toolbar__meta">
        {stateWords(state, props.now())}
      </span>
      <span className="device-toolbar__spacer" />
      {props.leases.length > 1 ? (
        <span aria-label="Desktops" className="desktop-pane__leases" role="group">
          {props.leases.map((each, index) => (
            <OctantButton
              aria-pressed={String(each.leaseId) === String(props.selected?.leaseId)}
              key={String(each.leaseId)}
              onClick={() => props.onSelect(each)}
              size="xs"
              type="button"
              variant={
                String(each.leaseId) === String(props.selected?.leaseId) ? "secondary" : "ghost"
              }
            >
              {`Desktop ${index + 1}`}
            </OctantButton>
          ))}
        </span>
      ) : null}
      {extendable && lease !== undefined ? (
        <OctantIconButton
          disabled={props.pending !== undefined}
          label={`Add ${extensionMinutes(lease)} minutes`}
          onClick={() => props.onExtend(lease)}
          title={`Add ${extensionMinutes(lease)} minutes`}
          type="button"
        >
          <Clock aria-hidden="true" size={16} />
        </OctantIconButton>
      ) : null}
      {running ? (
        <OctantIconButton
          disabled={props.pending !== undefined}
          label="Release desktop"
          onClick={props.onRelease}
          title="Release desktop"
          type="button"
        >
          <Power aria-hidden="true" size={16} />
        </OctantIconButton>
      ) : null}
    </div>
  );
}

function dotFor(state: DesktopPaneState): "running" | "busy" | "lost" | "idle" {
  switch (state.kind) {
    case "live":
      return "running";
    case "acquiring":
    case "releasing":
    case "not-shown":
      return "busy";
    case "interrupted":
    case "session-readable":
    case "release-failed":
      return "lost";
    default:
      return "idle";
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The toolbar's state in words, with elapsed time and expiry and never a cost. */
export function stateWords(state: DesktopPaneState, now: number): string {
  switch (state.kind) {
    case "loading":
      return "Checking";
    case "unavailable":
      return "Unavailable";
    case "setup":
      return "Not started";
    case "acquiring":
      return "Starting";
    case "releasing":
      return "Ending";
    case "release-failed":
      return "Still running";
    case "ended":
      return "Ended";
    case "live":
    case "interrupted":
    case "session-readable":
    case "not-shown": {
      const minutes = Math.max(0, Math.floor((now - Date.parse(state.lease.requestedAt)) / 60_000));
      const word =
        state.kind === "live"
          ? "Live"
          : state.kind === "interrupted"
            ? "Interrupted"
            : state.kind === "session-readable"
              ? "Not shown"
              : "Running";
      return `${word} · ${minutes} min · ends ${clock(Date.parse(state.lease.expiresAt))}`;
    }
  }
}

function DesktopStage(props: {
  readonly client: DesktopPaneClient;
  readonly threadId: string;
  readonly state: DesktopPaneState;
  readonly view: OpenView | undefined;
  readonly providers: DesktopOverview["providers"];
  readonly pending: string | undefined;
  readonly onStart: () => void;
  readonly onShow: (lease: DesktopLease) => void;
  readonly onRetry: (lease: DesktopLease) => void;
  readonly onLost: (reason?: string) => void;
  readonly onReadable: () => void;
}) {
  const { state } = props;
  switch (state.kind) {
    case "loading":
      return <DesktopCard busy title="Checking for desktops" />;
    case "unavailable":
      return <DesktopCard lede={state.message} title="Desktop is unavailable" />;
    case "setup":
      return state.start.status === "available" ? (
        <DesktopCard
          action={{ label: "Start desktop", run: props.onStart, busy: props.pending === "start" }}
          lede={`A throwaway Linux desktop on ${state.start.provider.displayName}, with no network and nothing of this computer's. You and the agent can both use it; it is destroyed when it ends.`}
          title="Start a desktop"
        />
      ) : (
        <DesktopCard lede={startRefusalMessage(state.start.reason)} title="No desktop to start" />
      );
    case "acquiring":
      return (
        <DesktopCard
          busy
          lede="Octant is creating the desktop. This can take a few seconds."
          title="Starting a desktop"
        />
      );
    case "not-shown":
      return (
        <DesktopCard
          action={{ label: "Show desktop", run: () => props.onShow(state.lease) }}
          lede="The desktop is running. A tab never reconnects to a desktop on its own."
          title="Desktop not shown here"
        />
      );
    case "interrupted":
      return (
        <DesktopCard
          action={{ label: "Reconnect", run: () => props.onShow(state.lease), icon: "reconnect" }}
          lede="The live view stopped. The desktop is still running."
          title="Live view interrupted"
        />
      );
    case "session-readable":
      return (
        <DesktopCard
          action={{ label: "Try again", run: () => props.onShow(state.lease), icon: "reconnect" }}
          lede={`Right now ${providerName(props.providers, String(state.lease.providerId))} reaches this desktop only through a connection that could be read on its way, so Octant shows nothing and sends nothing. The desktop is still running. Try again once it connects another way.`}
          title="Not shown: the connection could be read"
        />
      );
    case "releasing":
      return (
        <DesktopCard
          busy
          lede="Octant is destroying the desktop and checking that it is gone."
          title="Ending the desktop"
        />
      );
    case "release-failed":
      return (
        <DesktopCard
          action={{
            label: "Retry",
            run: () => props.onRetry(state.lease),
            busy: props.pending === "retry",
          }}
          lede={`Octant could not confirm that ${providerName(props.providers, String(state.lease.providerId))} destroyed this desktop, so it may still be running. Octant keeps trying, and no new desktop starts there until it is gone.`}
          title="Still running"
        />
      );
    case "ended":
      return (
        <DesktopCard
          {...(state.start.status === "available"
            ? {
                action: {
                  label: "Start a new desktop",
                  run: props.onStart,
                  busy: props.pending === "start",
                },
              }
            : {})}
          lede={
            state.start.status === "available"
              ? endedMessage(state.lease)
              : `${endedMessage(state.lease)} ${startRefusalMessage(state.start.reason)}`
          }
          title="Desktop ended"
        />
      );
    case "live":
      return props.view === undefined ||
        String(props.view.leaseId) !== String(state.lease.leaseId) ? (
        <DesktopCard busy title="Opening the desktop" />
      ) : (
        <DesktopScreen
          client={props.client}
          key={String(props.view.viewId)}
          onLost={props.onLost}
          onReadable={props.onReadable}
          threadId={props.threadId}
          view={props.view}
        />
      );
  }
}

function DesktopCard(props: {
  readonly title: string;
  readonly lede?: string;
  readonly busy?: boolean;
  readonly action?: {
    readonly label: string;
    readonly run: () => void;
    readonly busy?: boolean;
    readonly icon?: "reconnect";
  };
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="device-card desktop-pane__card">
      <div className="device-card__head">
        <h2 className="device-card__title" id={headingId}>
          {props.title}
        </h2>
        {props.busy === true ? <DeviceSpinner /> : null}
      </div>
      {props.lede === undefined ? null : <p className="device-card__lede">{props.lede}</p>}
      {props.action === undefined ? null : (
        <div className="device-card__actions">
          <OctantButton
            disabled={props.action.busy === true}
            onClick={props.action.run}
            size="sm"
            type="button"
          >
            {props.action.icon === "reconnect" ? <RotateCw aria-hidden="true" size={14} /> : null}
            {props.action.busy === true ? "Working…" : props.action.label}
          </OctantButton>
        </div>
      )}
    </section>
  );
}

/**
 * The live screen. Frames are read one at a time through the host and shown
 * as they arrive; nothing is kept once the next replaces it. Input goes out
 * in the order the person made it.
 */
function DesktopScreen(props: {
  readonly client: DesktopPaneClient;
  readonly threadId: string;
  readonly view: OpenView;
  readonly onLost: (reason?: string) => void;
  readonly onReadable: () => void;
}) {
  const { client, threadId, view, onLost, onReadable } = props;
  const [picture, setPicture] = useState<string>();
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number }>();
  const [focused, setFocused] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const captionId = useId();
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;
  const onReadableRef = useRef(onReadable);
  onReadableRef.current = onReadable;

  // Frames: one request at a time, quickly while the window shows, rarely
  // while it is hidden so the host keeps the view.
  useEffect(() => {
    let stopped = false;
    let missed = 0;
    let shown: string | undefined;
    const controller = new AbortController();
    const next = async () => {
      while (!stopped) {
        const started = Date.now();
        let answer: DesktopFrameAnswer;
        try {
          answer = await client.frame({ threadId, ...view }, controller.signal);
        } catch {
          if (!stopped) onLostRef.current("The host could not be reached.");
          return;
        }
        if (stopped) return;
        if (answer.status === "frame") {
          missed = 0;
          const url = URL.createObjectURL(answer.image);
          if (shown !== undefined) URL.revokeObjectURL(shown);
          shown = url;
          setPicture(url);
        } else if (answer.status === "refused") {
          if (answer.reason === "session-readable") onReadableRef.current();
          else {
            onLostRef.current(
              answer.reason === "view-ended" ? undefined : startRefusalMessage(answer.reason),
            );
          }
          return;
        } else {
          missed += 1;
          if (missed >= MISSED_FRAMES_BEFORE_LOST) {
            onLostRef.current("The desktop stopped sending its screen.");
            return;
          }
        }
        const interval =
          document.visibilityState === "visible" ? FRAME_INTERVAL_MS : HIDDEN_FRAME_INTERVAL_MS;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, interval - (Date.now() - started))),
        );
      }
    };
    void next();
    return () => {
      stopped = true;
      controller.abort();
      if (shown !== undefined) URL.revokeObjectURL(shown);
    };
  }, [client, threadId, view]);

  // Input: in order, one at a time. A pointer move still waiting at the end
  // of the queue is replaced by the newest one rather than queued; once any
  // other input queues behind it, the next move queues after that input, so
  // a move made after a press never overtakes the press.
  const queue = useRef(Promise.resolve());
  const waitingMove = useRef<{ event: DesktopInputEvent } | undefined>(undefined);
  const send = useCallback(
    (event: DesktopInputEvent) => {
      let slot: { event: DesktopInputEvent } | undefined;
      if (event.kind === "pointer" && event.action === "move") {
        if (waitingMove.current !== undefined) {
          waitingMove.current.event = event;
          return;
        }
        slot = { event };
        waitingMove.current = slot;
      } else {
        waitingMove.current = undefined;
      }
      queue.current = queue.current.then(async () => {
        if (slot !== undefined && waitingMove.current === slot) waitingMove.current = undefined;
        const outgoing = slot?.event ?? event;
        const answer = await client
          .request(decodeDesktopPaneRequest({ kind: "input", threadId, ...view, event: outgoing }))
          .catch(() => undefined);
        if (answer === undefined) onLostRef.current("The host could not be reached.");
        else if (answer.status === "refused" && answer.reason === "session-readable") {
          onReadableRef.current();
        } else if (answer.status === "refused") {
          onLostRef.current(
            answer.reason === "view-ended" ? undefined : startRefusalMessage(answer.reason),
          );
        }
      });
    },
    [client, threadId, view],
  );

  const typed = useRef("");
  const typedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flushText = useCallback(() => {
    if (typedTimer.current !== undefined) clearTimeout(typedTimer.current);
    typedTimer.current = undefined;
    const text = typed.current;
    typed.current = "";
    if (text.length > 0) send({ kind: "text", text });
  }, [send]);
  const wheel = useRef({ deltaX: 0, deltaY: 0, x: 0, y: 0 });
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flushWheel = useCallback(() => {
    if (wheelTimer.current !== undefined) clearTimeout(wheelTimer.current);
    wheelTimer.current = undefined;
    const { deltaX, deltaY, x, y } = wheel.current;
    wheel.current = { deltaX: 0, deltaY: 0, x, y };
    const clamp = (delta: number) => Math.max(-10_000, Math.min(10_000, Math.round(delta)));
    if (clamp(deltaX) === 0 && clamp(deltaY) === 0) return;
    send({ kind: "scroll", x, y, deltaX: clamp(deltaX), deltaY: clamp(deltaY) });
  }, [send]);
  // Gathered typing and scrolling go out before whatever the person does
  // next, so a click made after a scroll never reaches the desktop first.
  const flushPending = useCallback(() => {
    flushText();
    flushWheel();
  }, [flushText, flushWheel]);
  useEffect(
    () => () => {
      if (typedTimer.current !== undefined) clearTimeout(typedTimer.current);
      if (wheelTimer.current !== undefined) clearTimeout(wheelTimer.current);
    },
    [],
  );

  const pointAt = useCallback(
    (clientX: number, clientY: number) => {
      const element = image.current;
      if (element === null || natural === undefined) return undefined;
      const rect = element.getBoundingClientRect();
      return screenPoint(
        { x: clientX, y: clientY },
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        natural,
      );
    },
    [natural],
  );

  // A wheel listener that may cancel scrolling, which React's is not.
  useEffect(() => {
    const element = surface.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      const point = pointAt(event.clientX, event.clientY);
      if (point === undefined) return;
      event.preventDefault();
      const gathered = wheel.current;
      wheel.current = {
        deltaX: gathered.deltaX + event.deltaX,
        deltaY: gathered.deltaY + event.deltaY,
        ...point,
      };
      if (wheelTimer.current !== undefined) return;
      flushText();
      wheelTimer.current = setTimeout(flushWheel, SCROLL_FLUSH_MS);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [flushText, flushWheel, pointAt]);

  const button = (index: number) =>
    index === 1 ? "middle" : index === 2 ? "right" : ("left" as const);

  return (
    <div className="desktop-pane__fit">
      <div
        aria-describedby={captionId}
        aria-label="Desktop screen. Click to use it; keys go to it while it has focus"
        className="desktop-pane__screen"
        onBlur={() => {
          flushPending();
          setFocused(false);
        }}
        onContextMenu={(event) => event.preventDefault()}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          const intent = desktopKeyIntent({
            key: event.key,
            type: "keydown",
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
          });
          if (intent.kind === "ignore") return;
          if (intent.kind === "leave") {
            event.preventDefault();
            flushPending();
            event.currentTarget.blur();
            return;
          }
          event.preventDefault();
          if (intent.kind === "text") {
            flushWheel();
            typed.current += intent.text;
            if (typedTimer.current !== undefined) clearTimeout(typedTimer.current);
            typedTimer.current = setTimeout(flushText, TEXT_FLUSH_MS);
            return;
          }
          flushPending();
          send(intent.event);
        }}
        onKeyUp={(event) => {
          const intent = desktopKeyIntent({
            key: event.key,
            type: "keyup",
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
          });
          if (intent.kind !== "key") return;
          event.preventDefault();
          flushPending();
          send(intent.event);
        }}
        onPointerDown={(event) => {
          const point = pointAt(event.clientX, event.clientY);
          event.currentTarget.focus();
          if (point === undefined) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          flushPending();
          send({ kind: "pointer", action: "down", button: button(event.button), ...point });
        }}
        onPointerMove={(event) => {
          const point = pointAt(event.clientX, event.clientY);
          if (point !== undefined) send({ kind: "pointer", action: "move", ...point });
        }}
        onPointerUp={(event) => {
          const point = pointAt(event.clientX, event.clientY);
          if (point === undefined) return;
          flushPending();
          send({ kind: "pointer", action: "up", button: button(event.button), ...point });
        }}
        ref={surface}
        role="application"
        tabIndex={0}
      >
        {picture === undefined ? (
          <div className="desktop-pane__waiting">
            <DeviceSpinner />
          </div>
        ) : (
          <img
            alt="Desktop live screen"
            className="desktop-pane__picture"
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            ref={image}
            src={picture}
          />
        )}
      </div>
      <p className="device-stage__caption desktop-pane__caption" id={captionId}>
        {focused ? (
          <>
            <Monitor aria-hidden="true" size={12} /> Keys go to the desktop. Press{" "}
            {isApple() ? "⌘" : "Ctrl"}+Esc to leave.
          </>
        ) : (
          "Live through this host. Click the screen to use it."
        )}
      </p>
    </div>
  );
}

function isApple(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}
