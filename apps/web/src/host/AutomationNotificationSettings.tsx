import { useCallback, useEffect, useState } from "react";
import type { AutomationNotificationDeliveryStatus } from "@octant/contracts";
import {
  AutomationNotificationClientFailure,
  type AutomationNotificationClient,
} from "@octant/client-runtime/automation-notification-client";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingRow, SettingsFactList } from "../settings/primitives";

/**
 * Host Settings → Automation notifications. Opt-in preferences plus honest
 * enabled/unavailable delivery status. Never surfaces tokens or provider
 * credentials; credentialed APNs/FCM remains a named host residual.
 */
export interface AutomationNotificationSettingsProps {
  readonly client: AutomationNotificationClient;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: AutomationNotificationDeliveryStatus };

export function AutomationNotificationSettings(props: AutomationNotificationSettingsProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const status = await props.client.status();
      setState({ kind: "ready", status });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof AutomationNotificationClientFailure
            ? error.message
            : "Automation notification settings are unavailable.",
      });
    }
  }, [props.client]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleEnabled = async () => {
    if (state.kind !== "ready" || saving) return;
    setSaving(true);
    setMessage(undefined);
    const current = state.status.preferences;
    try {
      await props.client.update({
        enabled: !current.enabled,
        waiting: current.waiting,
        approvalNeeded: current.approvalNeeded,
        failure: current.failure,
        completion: current.completion,
        expectedVersion: current.version,
      });
      await load();
    } catch (error) {
      if (error instanceof AutomationNotificationClientFailure && error.code === "conflict") {
        setMessage("Notification preferences changed elsewhere. Reloading.");
        await load();
      } else {
        setMessage(
          error instanceof AutomationNotificationClientFailure
            ? error.message
            : "Could not update notification preferences.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <section aria-label="Automation notifications" className="host-settings__notifications">
        <p role="status">Loading automation notification settings…</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section aria-label="Automation notifications" className="host-settings__notifications">
        <p role="alert">{state.message}</p>
        <OctantButton onClick={() => void load()} type="button" variant="secondary">
          Retry
        </OctantButton>
      </section>
    );
  }

  const { status } = state;
  const providerLabel = status.providerDelivery === "available" ? "Available" : "Unavailable";
  const deliveryLabel = status.deliveryEnabled ? "Enabled" : "Unavailable";

  return (
    <section
      aria-label="Automation notifications"
      className="settings-card-section settings-card-section--open host-settings__notifications"
    >
      <h2>Automation notifications</h2>
      <p className="settings-section-note">
        Opt in to redacted host notifications for waiting, approval, failure, and completion.
        Payloads never include tokens, prompts, diffs, paths, credentials, or authority receipts.
      </p>
      <div className="setgroup">
        <SettingRow
          description="Deliver redacted notifications from this host."
          label="Notifications"
          scope="host"
          settingId="host-automation-notifications"
        >
          <OctantButton
            disabled={saving}
            onClick={() => void toggleEnabled()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {status.preferences.enabled ? "Disable notifications" : "Enable notifications"}
          </OctantButton>
        </SettingRow>
      </div>
      <SettingsFactList
        facts={[
          { label: "Preference", value: status.preferences.enabled ? "Enabled" : "Disabled" },
          { label: "Provider delivery", value: providerLabel },
          { label: "Registered destinations", value: status.registeredDestinationCount },
          { label: "Delivery", value: deliveryLabel },
        ]}
      />
      {message === undefined ? null : (
        <p className="settings-section-line" role="status">
          {message}
        </p>
      )}
      {status.providerDelivery === "unavailable" ? (
        <p className="settings-section-line">
          Credentialed APNs/FCM delivery is unavailable on this host until provider credentials are
          configured. Preferences and receipts still persist.
        </p>
      ) : null}
    </section>
  );
}
