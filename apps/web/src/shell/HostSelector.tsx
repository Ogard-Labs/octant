import type { HostHealth, HostId, HostIdentity } from "@octant/contracts/host";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { localHostDisplayName } from "@octant/client-runtime";
import {
  listCreateHostOptions,
  preselectCreateHost,
  type CreateHostViewScope,
} from "@octant/domain";
import { useEffect, useMemo, useState } from "react";
import { Cloud } from "lucide-react";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface HostSelectorProps {
  /** Product wording for the destination choice. Host is the system term;
   * Environment is the create-composer presentation people choose. */
  readonly presentation?: "host" | "environment";
  /**
   * When set, an existing Project fixes host ownership. With several hosts the
   * selector remains visible but does not offer an alternate destination.
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
      displayName: localHostDisplayName(),
      health: "connecting",
      capabilities: ["chat", "work", "code"],
    },
  ];
}

/**
 * The host a client is connected to and its health, with nothing to choose.
 * The remote shell names its one paired host this way; a create composer with
 * one host shows no host at all (see HostSelector).
 */
export function HostStatus(props: { readonly hosts?: ReadonlyArray<HostIdentity> }) {
  const host = resolveHosts(props.hosts)[0];
  const health = host?.health ?? "connecting";
  return (
    <HostStatusLabel
      className="host-selector"
      displayName={host?.displayName ?? localHostDisplayName()}
      environment={false}
      health={health}
      hostId={host?.hostId ?? LOCAL_HOST_ID}
    />
  );
}

function HostStatusLabel(props: {
  readonly className: string;
  readonly displayName: string;
  readonly environment: boolean;
  readonly health: HostHealth;
  readonly hostId: HostId;
}) {
  const healthLabel = healthLabels[props.health];
  return (
    <span
      aria-label={`${props.environment ? "Environment" : "Host"}: ${props.displayName} · ${healthLabel}`}
      className={props.className}
      data-host-health={props.health}
      data-host-id={props.hostId}
      data-testid="host-selector"
      role="status"
    >
      {props.environment ? (
        <Cloud
          aria-hidden="true"
          className="host-selector__environment-icon"
          size={14}
          strokeWidth={1.7}
        />
      ) : (
        <span aria-hidden="true" className={`host-selector__dot ${dotClass(props.health)}`} />
      )}
      <span className="host-selector__name">{props.displayName}</span>
      <span className="host-selector__health">{healthLabel}</span>
    </span>
  );
}

/**
 * Destination-host selector for Chat, Work, and Code create. It renders nothing
 * while only one host is known: there is no destination to choose, and a
 * permanent "This computer · Connected" label in every composer read as a
 * control that did nothing. With several hosts it is a dropdown, or a status
 * label when an existing Project fixes the host.
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
  const displayName = selected?.displayName ?? localHostDisplayName();
  const health = selected?.health ?? "connecting";
  const fixed = props.fixedHostId !== undefined;
  const interactive = !fixed && hosts.length > 1;
  const environment = props.presentation === "environment";
  const accessibleLabel = environment ? "Environment" : "Destination host";
  const className = `host-selector${interactive ? " host-selector--interactive" : ""}${environment ? " host-selector--environment" : ""}`;

  function handleChange(nextHostId: string) {
    const matched = hosts.find((host) => String(host.hostId) === nextHostId);
    if (matched === undefined) return;
    const option = options.find((entry) => entry.host.hostId === matched.hostId);
    if (option !== undefined && !option.selectable) return;
    if (!controlled) setInternalHostId(matched.hostId);
    props.onSelectHost?.(matched.hostId);
  }

  if (hosts.length <= 1) return null;

  if (!interactive) {
    return (
      <HostStatusLabel
        className={className}
        displayName={displayName}
        environment={environment}
        health={health}
        hostId={props.fixedHostId ?? selectedHostId}
      />
    );
  }

  return (
    <span
      className={className}
      data-host-health={health}
      data-host-id={selectedHostId}
      data-testid="host-selector"
    >
      {environment ? (
        <Cloud
          aria-hidden="true"
          className="host-selector__environment-icon"
          size={14}
          strokeWidth={1.7}
        />
      ) : (
        <span aria-hidden="true" className={`host-selector__dot ${dotClass(health)}`} />
      )}
      <label className="host-selector__label">
        <span className="host-selector__label-text">{accessibleLabel}</span>
        <OctantSelectField
          aria-label={accessibleLabel}
          className="host-selector__select"
          onValueChange={handleChange}
          options={options.map((option) => {
            const optionHealth = healthLabels[option.host.health];
            const suffix = environment
              ? option.disabledReason === undefined
                ? ""
                : ` — ${option.disabledReason}`
              : option.disabledReason !== undefined
                ? ` — ${option.disabledReason}`
                : ` — ${optionHealth}`;
            return {
              id: String(option.host.hostId),
              label: `${option.host.displayName}${suffix}`,
              ...(!option.selectable ? { disabled: true } : {}),
              ...(option.disabledReason === undefined
                ? {}
                : { disabledReason: option.disabledReason }),
            };
          })}
          value={String(selectedHostId)}
        />
      </label>
    </span>
  );
}
