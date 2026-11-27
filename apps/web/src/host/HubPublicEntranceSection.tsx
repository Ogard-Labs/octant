import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantSwitch } from "../ui/base/OctantSwitch";

/** This host's public entrance as the window sees it: the switch, where it listens, and the Funnel front. */
export interface PublicEntranceView {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly paused: boolean;
  readonly address?: string;
  readonly funnel: { readonly enabled: boolean; readonly port?: number };
  /** This host's own choice, as a named standby, to serve the entrance while it stands in. */
  readonly serveWhileStandingIn: boolean;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

export function readPublicEntrance(value: unknown): PublicEntranceView | undefined {
  const enabled = field(value, "enabled");
  const funnel = field(value, "funnel");
  const funnelOn = field(funnel, "enabled");
  if (typeof enabled !== "boolean" || typeof funnelOn !== "boolean") return undefined;
  const address = field(value, "address");
  const port = field(funnel, "port");
  return {
    enabled,
    listening: field(value, "listening") === true,
    paused: field(value, "paused") === true,
    ...(typeof address === "string" ? { address } : {}),
    funnel: { enabled: funnelOn, ...(typeof port === "number" ? { port } : {}) },
    serveWhileStandingIn: field(value, "serveWhileStandingIn") === true,
  };
}

export const PUBLIC_ENTRANCE_REFUSALS: Readonly<Record<string, string>> = {
  "not-in-a-hub": "Turn the hub role on, or join a hub, first.",
  "entrance-off": "Turn the public entrance on first.",
  "remote-access-paused": "Remote access is paused. Resume it first.",
  "port-shadows-private-listener":
    "The private listener serves on that port, and Funnel would hide it.",
  "funnel-not-allowed":
    "Tailscale refused Funnel. Turn on HTTPS and MagicDNS, and add the funnel node attribute in your tailnet policy.",
  "daemon-not-reachable": "Octant could not reach Tailscale on this computer.",
  "funnel-off-failed": "Tailscale did not turn Funnel off. Funnel is still on.",
  "listener-failed": "The public entrance could not open a port on this computer.",
  "not-a-named-standby": "The hub has not named this computer a standby.",
};

export function HubPublicEntranceSection(props: {
  readonly view: PublicEntranceView;
  readonly busy: boolean;
  readonly onEntrance: (on: boolean) => void;
  readonly onFunnel: (on: boolean) => void;
  /** This computer is a standby the hub named; only then can it choose to serve. */
  readonly namedStandby: boolean;
  readonly onStandbyServe: (on: boolean) => void;
  readonly focusedSetting?: string | undefined;
}) {
  const { view } = props;
  const funnelClosed = !view.enabled && !view.funnel.enabled;
  const mayServe = props.namedStandby || view.serveWhileStandingIn;
  return (
    <SettingsSection title="Public entrance">
      <div className="setgroup">
        <SettingRow
          description="Open one narrow door to the internet for visitor links, webhooks, and your own devices away from home."
          focused={props.focusedSetting === "hub-public-entrance"}
          label="Public entrance"
          more="It answers only those routes, never pairing, administration, or anything between your computers. Visitor links, webhooks, and the device relay each stay off until you turn them on. Pausing remote access closes it. Off by default."
          scope="host"
          settingId="hub-public-entrance"
        >
          <OctantSwitch
            checked={view.enabled}
            disabled={props.busy}
            label="Public entrance"
            onCheckedChange={props.onEntrance}
          />
        </SettingRow>
        <SettingRow
          description={
            funnelClosed
              ? "Turn the public entrance on first. Tailscale can then carry it."
              : "Let Tailscale carry the entrance on port 443 of this computer's tailnet name."
          }
          focused={props.focusedSetting === "hub-public-funnel"}
          label="Tailscale Funnel"
          more="TLS ends on this computer, so Tailscale's relays cannot read the traffic. Needs HTTPS, MagicDNS, and the funnel node attribute in your tailnet policy. Or point your own tunnel or proxy at the address below instead."
          scope="host"
          settingId="hub-public-funnel"
        >
          <OctantSwitch
            checked={view.funnel.enabled}
            disabled={props.busy || view.paused || funnelClosed}
            label="Tailscale Funnel"
            onCheckedChange={props.onFunnel}
          />
        </SettingRow>
        <SettingRow
          description={
            mayServe
              ? "While this computer stands in for the hub, answer visitor links and webhooks here. Off by default."
              : "Only a computer the hub named a standby can answer visitor links and webhooks while it stands in."
          }
          focused={props.focusedSetting === "hub-public-standby"}
          label="Serve the public entrance"
          scope="host"
          settingId="hub-public-standby"
        >
          <OctantSwitch
            checked={view.serveWhileStandingIn}
            disabled={props.busy || !mayServe}
            label="Serve the public entrance"
            onCheckedChange={props.onStandbyServe}
          />
        </SettingRow>
        {!view.enabled || view.address === undefined ? null : (
          <div className="setrow">
            <p className="setrow-hint">
              {view.paused
                ? "Closed while remote access is paused."
                : `Listening on this computer at ${view.address}${
                    view.funnel.enabled && view.funnel.port !== undefined
                      ? `; Funnel carries it on port ${view.funnel.port}.`
                      : "."
                  }`}
            </p>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
