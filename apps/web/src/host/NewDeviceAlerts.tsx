import type { NewDeviceAlertsClient } from "@octant/client-runtime/new-device-alerts-client";
import type { NewDeviceAlertList, NewDeviceAlertView } from "@octant/contracts";
import { useCallback, useEffect, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantButton } from "../ui/base/OctantButton";

/** Often enough that a device that just joined is seen while the person is still looking. */
const REFRESH_MS = 15_000;

export interface NewDeviceAlertsProps {
  readonly client: NewDeviceAlertsClient;
  /** The kinds this surface lists; a window lists hub members beside its Confirm new members. */
  readonly kinds?: ReadonlyArray<NewDeviceAlertView["kind"]>;
  /** Removes a directly paired device; given only where the host takes it (a window on it). */
  readonly onRemoveDevice?: (deviceId: string) => Promise<void>;
}

/**
 * Every device connected to a host is told when a new device joins the hub or
 * pairs with the host, with its name and private address (maintainer decision,
 * 2026-11-19). Remove stays with a window on the host and an owner device; any
 * other device is told where to go.
 */
export function NewDeviceAlerts(props: NewDeviceAlertsProps) {
  const { client } = props;
  const [list, setList] = useState<NewDeviceAlertList>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const read = await client.read();
    // A refusal keeps what is shown: an alert must not vanish because one read failed.
    if (read !== undefined) setList(read);
  }, [client]);

  useEffect(
    () => scheduleVisibleInterval(() => void refresh(), REFRESH_MS, { runImmediately: true }),
    [refresh],
  );

  const shown = (list?.alerts ?? []).filter(
    (alert) => props.kinds === undefined || props.kinds.includes(alert.kind),
  );
  if (list === undefined || shown.length === 0) return null;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ul aria-label="New devices" className="setgroup">
      {shown.map((alert) => (
        <li className="setrow" key={alert.alertId}>
          <span className="setrow-label">
            {alert.kind === "hub-member"
              ? `${alert.name} joined the hub`
              : `${alert.name} paired with this computer`}
          </span>
          <p className="setrow-hint">
            {alert.privateAddress === undefined ? null : `${alert.privateAddress} · `}
            {alert.kind === "hub-member" ? alert.role : "paired device"} · device key{" "}
            <code className="oct-meta--mono">
              {alert.kind === "hub-member" ? alert.identityKeyFingerprint : alert.deviceKeyFingerprint}
            </code>
            {list.removesHere
              ? ". If you did not add it, choose Remove."
              : ". If you did not add it, remove it from a window on this computer or an owner device."}
          </p>
          {list.removesHere && alert.kind === "paired-device" ? (
            <div className="setrow-control">
              {props.onRemoveDevice === undefined ? null : (
                <OctantButton
                  aria-label={`Remove ${alert.name} from this computer`}
                  disabled={busy}
                  onClick={() => {
                    const remove = props.onRemoveDevice;
                    if (remove !== undefined) void act(() => remove(alert.deviceId));
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove
                </OctantButton>
              )}
              <OctantButton
                aria-label={`Dismiss ${alert.name}`}
                disabled={busy}
                onClick={() => void act(() => client.dismiss(String(alert.alertId)))}
                size="sm"
                type="button"
                variant="ghost"
              >
                Dismiss
              </OctantButton>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
