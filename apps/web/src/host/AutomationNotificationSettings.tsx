import { useCallback, useEffect, useState } from "react";
import type { AutomationNotificationDeliveryStatus } from "@octant/contracts";
import {
  AutomationNotificationClientFailure,
  type AutomationNotificationClient,
} from "@octant/client-runtime/automation-notification-client";
import { OctantButton } from "../ui/base/OctantButton";

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
    <section aria-label="Automation notifications" className="host-settings__notifications">
      <h2 className="host-settings__heading">Automation notifications</h2>
      <p className="host-settings__note">
        Opt in to redacted host notifications for waiting, approval, failure, and completion.
        Payloads never include tokens, prompts, diffs, paths, credentials, or authority receipts.
      </p>
      {message === undefined ? null : (
        <p className="host-settings__note" role="status">
          {message}
        </p>
      )}
      <dl className="host-settings__facts">
        <dt>Preference</dt>
        <dd>{status.preferences.enabled ? "Enabled" : "Disabled"}</dd>
        <dt>Provider delivery</dt>
        <dd
          className={
            status.providerDelivery === "available"
              ? "github-settings__capability-state--available"
              : "github-settings__capability-state--unavailable"
          }
        >
          {providerLabel}
        </dd>
        <dt>Registered destinations</dt>
        <dd>{status.registeredDestinationCount}</dd>
        <dt>Delivery</dt>
        <dd
          className={
            status.deliveryEnabled
              ? "github-settings__capability-state--available"
              : "github-settings__capability-state--unavailable"
          }
        >
          {deliveryLabel}
        </dd>
      </dl>
      {status.providerDelivery === "unavailable" ? (
        <p className="host-settings__note">
          Credentialed APNs/FCM delivery is unavailable on this host until provider credentials are
          configured. Preferences and receipts still persist.
        </p>
      ) : null}
      <div className="host-settings__controls">
        <OctantButton disabled={saving} onClick={() => void toggleEnabled()} type="button">
          {status.preferences.enabled ? "Disable notifications" : "Enable notifications"}
        </OctantButton>
      </div>
    </section>
  );
}
