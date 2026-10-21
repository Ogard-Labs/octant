import type { LocalServerClient } from "@octant/client-runtime";
import type { LocalServerOpenTarget, RunningService } from "@octant/contracts";
import { CircleAlert, CircleHelp, ExternalLink, Globe2, Server, Square } from "lucide-react";
import { useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import {
  capRunningServices,
  NOT_OWNED_LABEL,
  REMOTE_OPEN_LIMITS,
  remoteOpenOffer,
  type RemoteOpenMode,
  type RemoteOpenOutcome,
  runningServiceHealthLabel,
  runningServiceName,
  runningServiceOrigin,
} from "./runningServices";
import { useRunningServices, type RunningServicesController } from "./useRunningServices";

export const RUNNING_SERVICES_CARD_ID = "running-services";

export interface RunningServicesCardSource {
  /** This window's Local servers reader; without one the card is not offered. */
  readonly client: LocalServerClient | undefined;
  /** Named only when the window is reading a computer that is not this one. */
  readonly host?: string;
  /**
   * Whether this window has somewhere to put the page for a service. A page the
   * host serves on its own loopback cannot be shown by another computer, so a
   * window reading a remote host offers Open only where the host can show it.
   */
  readonly canOpen: (service: RunningService) => boolean;
  /** Places a host-prepared target. May throw; the row then says Open failed. */
  readonly onOpenTarget: (
    service: RunningService,
    target: LocalServerOpenTarget,
  ) => void | Promise<void>;
  /**
   * Opens a server of another computer live on this one. Absent where this
   * window cannot (a browser without the desktop app, the phone); rows then
   * keep their picture of the page. The host judges every request again.
   */
  readonly openLive?: (service: RunningService, mode: RemoteOpenMode) => Promise<RemoteOpenOutcome>;
}

/**
 * The Running services card: the dev servers and other listeners running in the
 * host's Code Projects, the ones Octant owns and any other no editor is known to
 * have started. It is offered only where
 * the window has a client for the host, and refreshes only while it is mounted
 * and the document is visible.
 */
export function createRunningServicesCard(source: RunningServicesCardSource): HomeCardDefinition {
  return {
    id: RUNNING_SERVICES_CARD_ID,
    title: "Running services",
    icon: Server,
    defaultOn: false,
    available: source.client !== undefined,
    emptyLabel: "No servers are running in your Code Projects.",
    useContent: () => useRunningServicesContent(source),
  };
}

function useRunningServicesContent(source: RunningServicesCardSource): HomeCardContent {
  const controller = useRunningServices({ client: source.client });
  if (controller.status === "loading") return { status: "loading" };
  if (controller.status === "unavailable") {
    return {
      status: "ready",
      count: 0,
      body: null,
      emptyLabel: controller.unavailableMessage ?? "Octant could not check for running services.",
    };
  }
  return {
    status: "ready",
    count: controller.services.length,
    body: <RunningServiceRows controller={controller} source={source} />,
  };
}

function RunningServiceRows(props: {
  readonly controller: RunningServicesController;
  readonly source: RunningServicesCardSource;
}) {
  const { controller, source } = props;
  const [confirming, setConfirming] = useState<RunningService>();
  const { shown, hidden } = capRunningServices(controller.services);
  const { host, openLive } = source;
  return (
    <>
      {controller.failure === undefined ? null : (
        <OctantAlert className="running-services__alert" tone="danger">
          {controller.failure.message}
        </OctantAlert>
      )}
      <ul className="running-services__list">
        {shown.map((service) => (
          <li key={String(service.listenerId)}>
            <RunningServiceRow
              busy={controller.busyListenerId === service.listenerId}
              onOpen={async () => {
                const target = await controller.open(service);
                if (target !== undefined) await source.onOpenTarget(service, target);
              }}
              onStop={() =>
                service.stop.status === "available" && service.stop.confirmationRequired
                  ? setConfirming(service)
                  : void controller.stop(service, false)
              }
              openable={source.canOpen(service)}
              {...(openLive === undefined || host === undefined
                ? {}
                : {
                    remote: {
                      offer: remoteOpenOffer(service, host),
                      openLive: (mode: RemoteOpenMode) => openLive(service, mode),
                    },
                  })}
              service={service}
              {...(source.host === undefined ? {} : { host: source.host })}
            />
          </li>
        ))}
      </ul>
      {hidden <= 0 ? null : (
        <p className="oct-meta running-services__more">{`+${String(hidden)} more listening`}</p>
      )}
      {confirming === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Keep it running"
          confirmLabel="Stop this server"
          destructive
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => {
            const service = confirming;
            setConfirming(undefined);
            void controller.stop(service, true);
          }}
          title="Confirm stop"
        >
          Stop {confirming.processName} on port {String(confirming.port)}
          {confirming.workingDirectory === undefined ? "" : ` in ${confirming.workingDirectory}`}?
          Octant does not own this server and cannot tell who started it.
        </OctantConfirmDialog>
      )}
    </>
  );
}

function RunningServiceRow(props: {
  readonly service: RunningService;
  readonly host?: string;
  readonly busy: boolean;
  readonly openable: boolean;
  /** Present when this window can open a page of another computer live. */
  readonly remote?: {
    readonly offer: ReturnType<typeof remoteOpenOffer>;
    readonly openLive: (mode: RemoteOpenMode) => Promise<RemoteOpenOutcome>;
  };
  readonly onOpen: () => Promise<void>;
  readonly onStop: () => void;
}) {
  const { service } = props;
  const [openFailed, setOpenFailed] = useState(false);
  const [liveRefusal, setLiveRefusal] = useState<string>();
  const [liveNotice, setLiveNotice] = useState<string>();
  const [liveBusy, setLiveBusy] = useState(false);
  const live = props.remote?.offer?.kind === "live" ? props.remote : undefined;
  const openLive = async (mode: RemoteOpenMode) => {
    if (live === undefined) return;
    setLiveRefusal(undefined);
    setLiveBusy(true);
    try {
      const outcome = await live.openLive(mode);
      if (outcome.kind === "refused") setLiveRefusal(outcome.message);
      else if (outcome.notice !== undefined) setLiveNotice(outcome.notice);
    } catch {
      setLiveRefusal("Octant could not open this server.");
    } finally {
      setLiveBusy(false);
    }
  };
  const name = runningServiceName(service);
  const HealthIcon =
    service.health === "listening"
      ? Globe2
      : service.health === "unresponsive"
        ? CircleAlert
        : CircleHelp;
  const detail = [
    runningServiceHealthLabel(service.health),
    service.framework === undefined ? undefined : service.processName,
    service.ownership === "left-over" ? NOT_OWNED_LABEL : undefined,
    props.host,
  ].filter((part): part is string => part !== undefined);
  return (
    <div className="running-services__row" data-ownership={service.ownership}>
      <div className="running-services__main">
        <span className="running-services__head">
          <span className="oct-row-label running-services__name">{name}</span>
          <span className="oct-meta oct-meta--mono">{`:${String(service.port)}`}</span>
        </span>
        <span className="oct-meta running-services__origin" title={runningServiceOrigin(service)}>
          {runningServiceOrigin(service)}
        </span>
        <span className="oct-meta running-services__detail">
          <HealthIcon aria-hidden="true" size={12} strokeWidth={1.8} />
          <span className="running-services__detail-text">{detail.join(" · ")}</span>
        </span>
        {service.stop.status === "available" ? null : (
          <span className="oct-meta running-services__detail">
            <span className="running-services__detail-text" title={service.stop.reason}>
              {service.stop.reason}
            </span>
          </span>
        )}
        {props.remote?.offer?.kind === "explained" ? (
          <span className="oct-meta running-services__detail">
            <span className="running-services__detail-text">{props.remote.offer.reason}</span>
          </span>
        ) : null}
        {live === undefined ? null : (
          <span className="oct-meta running-services__detail">
            <span className="running-services__detail-text">{REMOTE_OPEN_LIMITS}</span>
          </span>
        )}
        {liveNotice === undefined ? null : (
          <span className="oct-meta running-services__detail">
            <span className="running-services__detail-text">{liveNotice}</span>
          </span>
        )}
        {liveRefusal === undefined ? null : (
          <OctantAlert className="running-services__alert" tone="danger">
            {liveRefusal}
          </OctantAlert>
        )}
        {openFailed ? (
          <OctantAlert className="running-services__alert" tone="danger">
            Octant could not open this server.
          </OctantAlert>
        ) : null}
      </div>
      <div className="running-services__actions">
        {live !== undefined ? (
          <>
            <OctantButton
              aria-label={`Open ${name} on port ${String(service.port)}`}
              className="window-no-drag"
              disabled={props.busy || liveBusy}
              onClick={() => void openLive("octant-browser")}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ExternalLink aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Open</span>
            </OctantButton>
            <OctantButton
              aria-label={`Open ${name} on port ${String(service.port)} in your browser`}
              className="window-no-drag"
              disabled={props.busy || liveBusy}
              onClick={() => void openLive("default-browser")}
              size="sm"
              type="button"
              variant="ghost"
            >
              <span>Open in browser</span>
            </OctantButton>
          </>
        ) : service.openAvailable && props.openable ? (
          <OctantButton
            aria-label={`Open ${name} on port ${String(service.port)}`}
            className="window-no-drag"
            disabled={props.busy}
            onClick={() =>
              void (async () => {
                setOpenFailed(false);
                try {
                  await props.onOpen();
                } catch {
                  setOpenFailed(true);
                }
              })()
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <ExternalLink aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Open</span>
          </OctantButton>
        ) : null}
        {service.stop.status === "available" ? (
          <OctantButton
            aria-label={`Stop ${name} on port ${String(service.port)}`}
            className="window-no-drag"
            disabled={props.busy}
            onClick={props.onStop}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Square aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Stop</span>
          </OctantButton>
        ) : null}
      </div>
    </div>
  );
}
