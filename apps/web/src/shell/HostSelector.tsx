import type { HostHealth, HostId, HostIdentity } from "@octant/contracts/host";
import { LOCAL_HOST_DISPLAY_NAME, LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  listCreateHostOptions,
  preselectCreateHost,
  type CreateHostViewScope,
} from "@octant/domain";
import { useEffect, useMemo, useState } from "react";

export interface HostSelectorProps {
  /**
   * When set, an existing Project fixes host ownership. The selector remains
   * visible but does not offer an alternate destination.
   */
  readonly fixedHostId?: HostId;
  /** Available hosts from observation / federation registry. */
  readonly hosts?: ReadonlyArray<HostIdentity>;
  /** Controlled selection used for create command envelopes. */
  readonly selectedHostId?: HostId;
  /** Most recently selected healthy host (All Hosts preselect). */
  readonly lastSelectedHealthyHostId?: HostId;
  /** Shell view scope used for contextual preselect. */
  readonly viewScope?: CreateHostViewScope;
  /** Optional mode capability that destination hosts must advertise. */
  readonly requiredCapability?: string;
  /** Fires when the user changes the destination before create. */
  readonly onSelectHost?: (hostId: HostId) => void;
}

const healthLabels: Record<HostHealth, string> = {
  healthy: "Connected",
  connecting: "Connecting",
  stale: "Stale connection",
  incompatible: "Incompatible host",
  unauthorized: "Unauthorized",
  unavailable: "Host unavailable",
};

function dotClass(health: HostHealth): string {
  switch (health) {
    case "healthy":
      return "host-selector__dot--healthy";
    case "stale":
      return "host-selector__dot--stale";
    case "connecting":
      return "host-selector__dot--connecting";
    case "incompatible":
    case "unauthorized":
    case "unavailable":
      return "host-selector__dot--disconnected";
  }
}

function resolveHosts(hosts: ReadonlyArray<HostIdentity> | undefined): ReadonlyArray<HostIdentity> {
  if (hosts !== undefined && hosts.length > 0) return hosts;
  return [
    {
      hostId: LOCAL_HOST_ID,
      displayName: LOCAL_HOST_DISPLAY_NAME,
      health: "connecting",
      capabilities: ["chat", "work", "code"],
    },
  ];
}

/**
 * Always-visible destination-host selector for Chat, Work, and Code create.
 * Multi-host input is always accepted; the control collapses to a status label
 * when only one host is present or when an existing Project fixes the host.
 */
export function HostSelector(props: HostSelectorProps) {
  const hosts = useMemo(() => resolveHosts(props.hosts), [props.hosts]);
  const options = useMemo(
    () =>
      listCreateHostOptions(hosts, {
        ...(props.requiredCapability === undefined
          ? {}
          : { requiredCapability: props.requiredCapability }),
        ...(props.fixedHostId === undefined ? {} : { projectHostId: props.fixedHostId }),
      }),
    [hosts, props.fixedHostId, props.requiredCapability],
  );

  const preselected = useMemo(() => {
    const result = preselectCreateHost({
      hosts,
      ...(props.viewScope === undefined ? {} : { viewScope: props.viewScope }),
      ...(props.lastSelectedHealthyHostId === undefined
        ? {}
        : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId }),
      ...(props.fixedHostId === undefined ? {} : { projectHostId: props.fixedHostId }),
      ...(props.requiredCapability === undefined
        ? {}
        : { requiredCapability: props.requiredCapability }),
    });
    return result.kind === "selected" ? result.host.hostId : (hosts[0]?.hostId ?? LOCAL_HOST_ID);
  }, [
    hosts,
    props.fixedHostId,
    props.lastSelectedHealthyHostId,
    props.requiredCapability,
    props.viewScope,
  ]);

  const controlled = props.selectedHostId !== undefined;
  const [internalHostId, setInternalHostId] = useState<HostId>(props.selectedHostId ?? preselected);

  useEffect(() => {
    if (controlled) return;
    setInternalHostId(preselected);
  }, [controlled, preselected]);

  const selectedHostId = props.selectedHostId ?? internalHostId;
  const selected =
    hosts.find((host) => host.hostId === selectedHostId) ??
    hosts.find((host) => host.hostId === preselected) ??
    hosts[0];
  const displayName = selected?.displayName ?? LOCAL_HOST_DISPLAY_NAME;
  const health = selected?.health ?? "connecting";
  const healthLabel = healthLabels[health];
  const fixed = props.fixedHostId !== undefined;
  const interactive = !fixed && hosts.length > 1;

  function handleChange(nextHostId: string) {
    const matched = hosts.find((host) => String(host.hostId) === nextHostId);
    if (matched === undefined) return;
    const option = options.find((entry) => entry.host.hostId === matched.hostId);
    if (option !== undefined && !option.selectable) return;
    if (!controlled) setInternalHostId(matched.hostId);
    props.onSelectHost?.(matched.hostId);
  }

  if (!interactive) {
    return (
      <span
        aria-label={`Host: ${displayName} · ${healthLabel}`}
        className="host-selector"
        data-host-health={health}
        data-host-id={props.fixedHostId ?? selectedHostId}
        data-testid="host-selector"
        role="status"
      >
        <span aria-hidden="true" className={`host-selector__dot ${dotClass(health)}`} />
        <span className="host-selector__name">{displayName}</span>
        <span className="host-selector__health">{healthLabel}</span>
      </span>
    );
  }

  return (
    <span
      className="host-selector host-selector--interactive"
      data-host-health={health}
      data-host-id={selectedHostId}
      data-testid="host-selector"
    >
      <span aria-hidden="true" className={`host-selector__dot ${dotClass(health)}`} />
      <label className="host-selector__label">
        <span className="host-selector__label-text">Destination host</span>
        <select
          aria-label="Destination host"
          className="host-selector__select"
          onChange={(event) => handleChange(event.target.value)}
          value={String(selectedHostId)}
        >
          {options.map((option) => {
            const optionHealth = healthLabels[option.host.health];
            const suffix =
              option.disabledReason !== undefined
                ? ` — ${option.disabledReason}`
                : ` — ${optionHealth}`;
            return (
              <option
                disabled={!option.selectable}
                key={String(option.host.hostId)}
                title={option.disabledReason}
                value={String(option.host.hostId)}
              >
                {option.host.displayName}
                {suffix}
              </option>
            );
          })}
        </select>
      </label>
    </span>
  );
}
