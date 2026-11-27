import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { field, list, useHubEntranceAction, type HubRequest } from "./hubEntranceAction";

/**
 * Settings › Remote access › Device relay: on the hub, the switch that lets
 * paired devices reach their hosts through the public entrance; on a member,
 * which of its own paired devices it lists for that. The hub carries only
 * ciphertext and learns only a listed key's fingerprint. Loaded as its own
 * chunk (hub-and-spokes.md, Your own devices through the hub).
 */

interface RelayView {
  readonly hub?: { readonly enabled: boolean; readonly hosts: number; readonly tunnels: number };
  readonly devices: ReadonlyArray<{ readonly deviceId: string; readonly allowed: boolean }>;
}

export function readRelay(value: unknown): RelayView | undefined {
  const hub = field(value, "hub");
  const enabled = field(hub, "enabled");
  if (typeof enabled !== "boolean") return undefined;
  const hosts = field(hub, "hosts");
  const tunnels = field(hub, "tunnels");
  return {
    hub: {
      enabled,
      hosts: typeof hosts === "number" ? hosts : 0,
      tunnels: typeof tunnels === "number" ? tunnels : 0,
    },
    devices: list(field(value, "devices")).flatMap((entry) => {
      const deviceId = field(entry, "deviceId");
      return typeof deviceId === "string"
        ? [{ deviceId, allowed: field(entry, "allowed") === true }]
        : [];
    }),
  };
}

const REFUSALS: Readonly<Record<string, string>> = {
  "unknown-device": "That device is no longer paired with this computer.",
};

export default function HubDeviceRelaySection(props: {
  readonly request: HubRequest;
  /** The status body's `relay` part, read here so the parsing loads with this chunk. */
  readonly body: unknown;
  /** This computer acts as hub: its window holds the relay switch. */
  readonly hubOn: boolean;
  /** This computer is a member: its window lists its own devices. */
  readonly member: boolean;
  /** Whether this computer's person ticked Relay in its hub grant. */
  readonly relayGranted: boolean;
  /** This computer's paired devices' names, by device id. */
  readonly deviceNames: ReadonlyMap<string, string>;
  readonly onChanged: () => Promise<void>;
}) {
  const view = readRelay(props.body);
  const action = useHubEntranceAction(props.request);
  if (view === undefined) return null;

  const setRelay = async (on: boolean) => {
    const body = await action.run(
      "relay",
      { enabled: on },
      "changed",
      on
        ? "Octant could not turn the device relay on."
        : "Octant could not turn the device relay off.",
    );
    if (body !== undefined) {
      action.say({
        kind: "success",
        text: on
          ? "Device relay is on. A member's device comes through only if that member lists it."
          : "Device relay is off. Every open relay ended.",
      });
    }
    await props.onChanged();
  };

  const allow = async (deviceId: string, name: string, allowed: boolean) => {
    const body = await action.run(
      "relay-device",
      { deviceId, allowed },
      "changed",
      "Octant could not change that device.",
      REFUSALS,
    );
    if (body !== undefined) {
      action.say({
        kind: "success",
        text: allowed
          ? `${name} may reach this computer through the hub.`
          : `${name} no longer comes through the hub. Its open relays ended.`,
      });
    }
    await props.onChanged();
  };

  return (
    <SettingsSection
      description="Let your own paired phone and computers reach this computer through the hub when they are away from home."
      title="Device relay"
    >
      {!props.hubOn || view.hub === undefined ? null : (
        <div className="setgroup">
          <div className="setrow">
            <span className="setrow-label">Device relay</span>
            <p className="setrow-hint">
              {view.hub.enabled
                ? `Carry paired devices' encrypted traffic to the members that list them. ${view.hub.hosts} member${view.hub.hosts === 1 ? "" : "s"} listed devices; ${view.hub.tunnels} open now.`
                : "Carry paired devices' encrypted traffic to the members that list them. Off by default."}
            </p>
            <div className="setrow-control">
              <OctantSwitch
                checked={view.hub.enabled}
                disabled={action.busy}
                label="Device relay"
                onCheckedChange={(on) => void setRelay(on)}
              />
            </div>
          </div>
        </div>
      )}
      {!props.member ? null : (
        <>
          <p className="setrow-hint">
            {props.relayGranted
              ? "Pick which devices may come through the hub. The hub learns only each device's key fingerprint, never what it sends."
              : "Tick Relay in this computer's hub grant to let a device come through the hub."}
          </p>
          {view.devices.length === 0 ? (
            <SettingsState kind="empty">No devices are paired with this computer.</SettingsState>
          ) : (
            <ul aria-label="Devices through the hub" className="setgroup">
              {view.devices.map((device) => {
                const name = props.deviceNames.get(device.deviceId) ?? "A paired device";
                return (
                  <li className="setrow" key={device.deviceId}>
                    <span className="setrow-label">{name}</span>
                    <p className="setrow-hint">
                      {device.allowed ? "Comes through the hub" : "Private network only"}
                    </p>
                    <div className="setrow-control">
                      <OctantSwitch
                        checked={device.allowed}
                        disabled={action.busy || (!props.relayGranted && !device.allowed)}
                        label={`Let ${name} through the hub`}
                        onCheckedChange={(on) => void allow(device.deviceId, name, on)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {action.notice === undefined ? null : (
        <SettingsState kind={action.notice.kind}>{action.notice.text}</SettingsState>
      )}
    </SettingsSection>
  );
}
