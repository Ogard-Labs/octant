import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantSwitch } from "../ui/base/OctantSwitch";

/** This host's public entrance as the window sees it: the switch, where it listens, and the Funnel front. */
export interface PublicEntranceView {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly paused: boolean;
  readonly address?: string;
  readonly funnel: { readonly enabled: boolean; readonly port?: number };
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
};

export function HubPublicEntranceSection(props: {
  readonly view: PublicEntranceView;
  readonly busy: boolean;
  readonly onEntrance: (on: boolean) => void;
  readonly onFunnel: (on: boolean) => void;
}) {
  const { view } = props;
  return (
    <SettingsSection title="Public entrance">
      <div className="setgroup">
        <SettingRow
          description="Open one narrow door to the internet for visitor links, webhooks, and your own devices away from home. It answers only those routes, never pairing, administration, or anything between your computers. Visitor links, webhooks, and the device relay each stay off until you turn them on. Pausing remote access closes it. Off by default."
          label="Public entrance"
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
        {!view.enabled && !view.funnel.enabled ? null : (
          <SettingRow
            description="Let Tailscale carry the entrance on port 443 of this computer's tailnet name. TLS ends on this computer, so Tailscale's relays cannot read the traffic. Needs HTTPS, MagicDNS, and the funnel node attribute in your tailnet policy. Or point your own tunnel or proxy at the address below instead."
            label="Tailscale Funnel"
            scope="host"
            settingId="hub-public-funnel"
          >
            <OctantSwitch
              checked={view.funnel.enabled}
              disabled={props.busy || view.paused}
              label="Tailscale Funnel"
              onCheckedChange={props.onFunnel}
            />
          </SettingRow>
        )}
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
