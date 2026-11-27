import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { failureMessage } from "../lib/failureMessage";
import {
  SettingRow,
  SettingsSection,
  SettingsState,
  useRevealedFocus,
} from "../settings/primitives";
import type {
  HubAdministrationBridge,
  RemoteAccessAdministrationBridge,
} from "../shell/hostBridge";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { field, list, useHubEntranceAction, type HubRequest } from "./hubEntranceAction";
import HubDeviceRelaySection, { readRelay } from "./HubDeviceRelaySection";
import {
  HubPublicEntranceSection,
  PUBLIC_ENTRANCE_REFUSALS,
  readPublicEntrance,
  type PublicEntranceView,
} from "./HubPublicEntranceSection";
import HubVisitorLinksSection from "./HubVisitorLinksSection";
import HubWebhooksSection, { readWebhooks } from "./HubWebhooksSection";
import { readVisitors } from "./VisitorLinks";

/**
 * Settings › Public entrance: this computer's one narrow door to the
 * internet, and the visitor links, webhooks and device relay behind it. It
 * reads the same loopback hub status as the hub settings and loads as its own
 * chunk with those screens, since the main one has no room for them.
 *
 * Settings search lists every control here on every computer, so a control
 * this computer cannot use keeps its row and says why.
 */
export interface PublicEntranceSettingsSectionProps {
  /** The loopback hub administration; absent in a paired browser. */
  readonly hub?: HubAdministrationBridge;
  /** Names this computer's paired devices for the relay's list. */
  readonly devices?: Pick<RemoteAccessAdministrationBridge, "getRemoteDeviceInventory">;
  /** Thread titles by `mode:threadId`, for the visitor links list. */
  readonly threadTitles?: ReadonlyMap<string, string>;
  readonly focusedSetting?: string;
  readonly now?: () => number;
}

interface EntranceStatus {
  readonly hubOn: boolean;
  readonly member: boolean;
  readonly namedStandby: boolean;
  readonly publicGranted: boolean;
  readonly relayGranted: boolean;
  readonly entrance?: PublicEntranceView;
  /** Each lazy screen reads its own part of the status body. */
  readonly webhooks: unknown;
  readonly relay: unknown;
  readonly visitors: unknown;
}

function readEntranceStatus(body: unknown): EntranceStatus | undefined {
  const hubOn = field(field(body, "hub"), "enabled");
  if (typeof hubOn !== "boolean") return undefined;
  const spoke = field(body, "spoke");
  const member = field(spoke, "membership") === "member";
  const granted = list(field(field(spoke, "grant"), "items"));
  const entrance = readPublicEntrance(field(body, "publicEntrance"));
  return {
    hubOn,
    member,
    namedStandby: member && field(spoke, "namedStandby") === true,
    publicGranted: granted.includes("public"),
    relayGranted: granted.includes("relay"),
    ...(entrance === undefined ? {} : { entrance }),
    webhooks: field(body, "webhooks"),
    relay: field(body, "relay"),
    visitors: field(body, "visitors"),
  };
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const READ_FAILED = "Octant could not read the hub status.";
const NO_BRIDGE: HubRequest = async () => ({ status: 503, body: undefined });

export default function PublicEntranceSettingsSection(props: PublicEntranceSettingsSectionProps) {
  const request = props.hub?.hubAdministrationRequest ?? NO_BRIDGE;
  const requestRef = useRef(request);
  requestRef.current = request;
  const stableRequest = useCallback<HubRequest>(
    (operation, body) =>
      body === undefined ? requestRef.current(operation) : requestRef.current(operation, body),
    [],
  );
  const action = useHubEntranceAction(stableRequest);
  /**
   * The last good read stays beside a later failure: a screen below may be
   * showing a secret the host mints once, and dropping it would lose it.
   */
  const [loaded, setLoaded] = useState<{
    readonly status?: EntranceStatus;
    readonly error?: string;
  }>({});
  const present = props.hub !== undefined;

  const refresh = useCallback(async () => {
    const failed = (error: string) => setLoaded((previous) => ({ ...previous, error }));
    try {
      const reply = await stableRequest("status");
      const status = reply.status === 200 ? readEntranceStatus(reply.body) : undefined;
      if (status === undefined) failed(READ_FAILED);
      else setLoaded({ status });
    } catch (error) {
      failed(failureMessage(error, READ_FAILED));
    }
  }, [stableRequest]);

  useEffect(() => {
    if (present) void refresh();
  }, [present, refresh]);

  const [deviceNames, setDeviceNames] = useState(NO_NAMES);
  const inventory = props.devices?.getRemoteDeviceInventory;
  useEffect(() => {
    let closed = false;
    // A device the inventory cannot name reads as "A paired device".
    void inventory?.().then(
      (devices) => {
        if (!closed) {
          setDeviceNames(
            new Map(devices.map((device) => [String(device.deviceId), device.deviceLabel])),
          );
        }
      },
      () => undefined,
    );
    return () => {
      closed = true;
    };
    // The bridge is one object per window; its methods are read once.
  }, [inventory === undefined]);

  const change = async (
    operation: "public" | "public-funnel" | "public-standby",
    body: unknown,
    failure: string,
    success: string,
  ) => {
    const reply = await action.run(operation, body, "changed", failure, PUBLIC_ENTRANCE_REFUSALS);
    if (reply !== undefined) action.say({ kind: "success", text: success });
    await refresh();
  };

  // A failed first read leaves no status; the rows still show, saying why.
  const status = loaded.status;
  if (present && status === undefined && loaded.error === undefined) {
    return <SettingsState kind="loading">Reading the public entrance…</SettingsState>;
  }
  const shown = status !== undefined && (status.hubOn || status.member);
  const entrance = shown ? status.entrance : undefined;
  const unavailable = !present
    ? "Set this up in the Octant app or with octant hub public on the computer itself."
    : status === undefined
      ? "Octant could not read this computer's hub status."
      : shown
        ? "This computer has not reported it."
        : "Turn on the hub role in Remote access, or join a hub, first.";
  const focused = (settingId: string) => props.focusedSetting === settingId;
  const clock = props.now === undefined ? {} : { now: props.now };

  return (
    <section
      aria-label="Public entrance"
      className="settings-section settings-section-stack"
      id="settings-public-entrance"
    >
      {entrance === undefined ? (
        <SettingsSection title="Public entrance">
          <div className="setgroup">
            <UnavailableRow
              focused={focused("hub-public-entrance")}
              label="Public entrance"
              reason={unavailable}
              settingId="hub-public-entrance"
              toggle
            />
            <UnavailableRow
              focused={focused("hub-public-funnel")}
              label="Tailscale Funnel"
              reason={unavailable}
              settingId="hub-public-funnel"
              toggle
            />
            <UnavailableRow
              focused={focused("hub-public-standby")}
              label="Serve the public entrance"
              reason={unavailable}
              settingId="hub-public-standby"
              toggle
            />
          </div>
        </SettingsSection>
      ) : (
        <HubPublicEntranceSection
          busy={action.busy}
          focusedSetting={props.focusedSetting}
          namedStandby={status?.namedStandby === true}
          onEntrance={(on) =>
            void change(
              "public",
              { enabled: on },
              on
                ? "Octant could not open the public entrance."
                : "Octant could not close the public entrance.",
              on
                ? "Public entrance is open on this computer. Turn on Funnel, or point your own front at it."
                : "Public entrance is closed.",
            )
          }
          onFunnel={(on) =>
            void change(
              "public-funnel",
              on ? { enabled: true, port: 443 } : { enabled: false },
              on ? "Octant could not turn Funnel on." : "Octant could not turn Funnel off.",
              on ? "Funnel carries the public entrance on port 443." : "Funnel is off.",
            )
          }
          onStandbyServe={(on) =>
            void change(
              "public-standby",
              { enabled: on },
              on
                ? "Octant could not turn on serving while standing in."
                : "Octant could not turn off serving while standing in.",
              on
                ? "Serve the public entrance is on. This computer answers visitor links and webhooks only while it stands in for the hub."
                : "Serve the public entrance is off. While standing in, this computer's entrance forwards and serves nothing itself.",
            )
          }
          view={entrance}
        />
      )}
      {action.notice === undefined ? null : (
        <SettingsState kind={action.notice.kind}>{action.notice.text}</SettingsState>
      )}
      {loaded.error === undefined ? null : (
        <SettingsState kind="error">{loaded.error}</SettingsState>
      )}
      {shown && readVisitors(status.visitors) !== undefined ? (
        <SettingAnchor focused={focused("hub-visitor-links")} settingId="hub-visitor-links">
          <HubVisitorLinksSection
            body={status.visitors}
            hubOn={status.hubOn}
            member={status.member}
            onChanged={refresh}
            request={stableRequest}
            threadTitles={props.threadTitles ?? NO_NAMES}
            {...clock}
          />
        </SettingAnchor>
      ) : (
        <UnavailableSection
          focused={focused("hub-visitor-links")}
          label="Visitor links"
          reason={unavailable}
          settingId="hub-visitor-links"
        />
      )}
      {shown && readWebhooks(status.webhooks) !== undefined ? (
        <SettingAnchor focused={focused("hub-webhook-endpoints")} settingId="hub-webhook-endpoints">
          <HubWebhooksSection
            body={status.webhooks}
            member={status.member}
            onChanged={refresh}
            publicGranted={status.publicGranted}
            request={stableRequest}
            {...clock}
          />
        </SettingAnchor>
      ) : (
        <UnavailableSection
          focused={focused("hub-webhook-endpoints")}
          label="Webhook endpoints"
          reason={unavailable}
          settingId="hub-webhook-endpoints"
        />
      )}
      {shown && readRelay(status.relay) !== undefined ? (
        <SettingAnchor focused={focused("hub-device-relay")} settingId="hub-device-relay">
          <HubDeviceRelaySection
            body={status.relay}
            deviceNames={deviceNames}
            hubOn={status.hubOn}
            member={status.member}
            onChanged={refresh}
            relayGranted={status.relayGranted}
            request={stableRequest}
          />
        </SettingAnchor>
      ) : (
        <UnavailableSection
          focused={focused("hub-device-relay")}
          label="Device relay"
          reason={unavailable}
          settingId="hub-device-relay"
        />
      )}
    </section>
  );
}

/** Where a search result or a link lands on a whole section: its first control. */
function SettingAnchor(props: {
  readonly settingId: string;
  readonly focused: boolean;
  readonly children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  useRevealedFocus(anchor, props.focused);
  return (
    <div data-setting-id={props.settingId} ref={anchor} tabIndex={-1}>
      {props.children}
    </div>
  );
}

function UnavailableRow(props: {
  readonly settingId: string;
  readonly label: string;
  readonly reason: string;
  readonly focused: boolean;
  readonly toggle?: boolean;
}) {
  return (
    <SettingRow
      description={props.reason}
      focused={props.focused}
      label={props.label}
      scope="host"
      settingId={props.settingId}
    >
      {props.toggle === true ? (
        <OctantSwitch
          checked={false}
          disabled
          label={props.label}
          onCheckedChange={() => undefined}
        />
      ) : null}
    </SettingRow>
  );
}

function UnavailableSection(props: Parameters<typeof UnavailableRow>[0]) {
  return (
    <SettingsSection title={props.label}>
      <div className="setgroup">
        <UnavailableRow {...props} />
      </div>
    </SettingsSection>
  );
}
