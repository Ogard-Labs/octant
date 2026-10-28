import {
  AutomationNotificationClientFailure,
  type AutomationNotificationClient,
} from "@octant/client-runtime/automation-notification-client";
import {
  decodeSetRemotePushGatewaySettingsV1,
  type RemotePushGatewaySettingsV1,
} from "@octant/contracts/remote-push-notifications";
import { useCallback, useEffect, useId, useState } from "react";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSwitch } from "../ui/base/OctantSwitch";

export interface PhoneNotificationSettingsProps {
  readonly client: Pick<AutomationNotificationClient, "pushGateway" | "setPushGateway">;
  readonly focusedSetting?: string | undefined;
}

/** What the switch means: the gateway carries sealed notifications it cannot read. */
export const PHONE_NOTIFICATIONS_FACT =
  "Let paired phones get notifications from this computer. They are sent through the push gateway below, sealed so only the phone can read them; the gateway sees when a phone is notified, never what about.";

/**
 * Settings › Notifications: the switch that lets this host notify paired
 * phones, and the push gateway it sends through. Both are saved together from
 * the version the person read, so a change made in another window is refused
 * rather than overwritten.
 */
export function PhoneNotificationSettings(props: PhoneNotificationSettingsProps) {
  const { client } = props;
  const urlId = useId();
  const [settings, setSettings] = useState<RemotePushGatewaySettingsV1 | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next = await client.pushGateway();
      setSettings(next);
      setGatewayUrl(next.gatewayUrl);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(enabled: boolean, nextGatewayUrl: string) {
    if (settings === undefined) return;
    setProblem(undefined);
    let command;
    try {
      command = decodeSetRemotePushGatewaySettingsV1({
        enabled,
        gatewayUrl: nextGatewayUrl.trim(),
        expectedVersion: settings.version,
      });
    } catch {
      setProblem(
        "The gateway address must be an https address, or http on this computer's loopback address, with no password, query, or fragment.",
      );
      return;
    }
    setBusy(true);
    try {
      const saved = await client.setPushGateway(command);
      setSettings(saved);
      setGatewayUrl(saved.gatewayUrl);
    } catch (error) {
      if (error instanceof AutomationNotificationClientFailure && error.code === "conflict") {
        setProblem("Phone notification settings changed in another window. Reloaded.");
        await load();
      } else {
        setProblem("Phone notification settings could not be saved.");
      }
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (settings === undefined) {
    body = (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed
          ? "Phone notification settings could not be read from this host."
          : "Reading phone notification settings…"}
      </SettingsState>
    );
  } else {
    const changedUrl = gatewayUrl.trim() !== settings.gatewayUrl;
    body = (
      <div className="setgroup">
        <SettingRow
          description={PHONE_NOTIFICATIONS_FACT}
          focused={props.focusedSetting === "host-phone-notifications"}
          label="Phone notifications"
          scope="host"
          settingId="host-phone-notifications"
        >
          <OctantSwitch
            checked={settings.enabled}
            disabled={busy}
            label="Phone notifications"
            onCheckedChange={(enabled) => void save(enabled, settings.gatewayUrl)}
          />
        </SettingRow>
        <SettingRow
          description={`Notifications go through ${settings.gatewayUrl}. Change it to use a gateway you run; a phone must get its delivery permit from the same gateway.`}
          focused={props.focusedSetting === "host-push-gateway"}
          htmlFor={urlId}
          label="Push gateway"
          scope="host"
          settingId="host-push-gateway"
        >
          <OctantInput
            disabled={busy}
            id={urlId}
            onChange={(event) => setGatewayUrl(event.target.value)}
            type="url"
            value={gatewayUrl}
          />
          <OctantButton
            disabled={busy || !changedUrl}
            onClick={() => void save(settings.enabled, gatewayUrl)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Save address
          </OctantButton>
        </SettingRow>
      </div>
    );
  }
  return (
    <SettingsSection
      description="Thread and automation notifications for phones paired with this computer. Off until you turn it on."
      title="Phone notifications"
    >
      {body}
      {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
    </SettingsSection>
  );
}
