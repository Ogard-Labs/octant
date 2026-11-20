import type { MobileRemoteTransport } from "@octant/client-runtime";
import { readMobileNewDeviceAlerts } from "@octant/client-runtime/new-device-alerts-client";
import type { NewDeviceAlertView } from "@octant/contracts";

export interface NewDeviceRow {
  readonly key: string;
  /** The computer that raised the alert, as this phone paired it. */
  readonly computer: string;
  readonly title: string;
  readonly detail: string;
  readonly fingerprint: string;
  readonly raisedAt: string;
}

export interface NewDevicesReading {
  readonly rows: ReadonlyArray<NewDeviceRow>;
  /** Computers that did not answer, by name, so a quiet list is not read as "none". */
  readonly unanswered: ReadonlyArray<string>;
}

/**
 * Every paired computer's new-device alerts, newest first (maintainer
 * decision, 2026-11-19). The phone only reads them: Remove stays with a window
 * on that computer or an owner device, so each row says where to go.
 */
export async function readNewDevicesAcross(input: {
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
  readonly computerName: (hostId: string) => string;
  readonly signal?: AbortSignal;
}): Promise<NewDevicesReading> {
  const rows: NewDeviceRow[] = [];
  const unanswered: string[] = [];
  await Promise.all(
    input.transports.map(async (transport) => {
      const computer = input.computerName(transport.hostId);
      const list = await readMobileNewDeviceAlerts({
        transport,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (list === undefined) {
        unanswered.push(computer);
        return;
      }
      for (const alert of list.alerts) rows.push(newDeviceRow(transport.hostId, computer, alert));
    }),
  );
  rows.sort((left, right) => right.raisedAt.localeCompare(left.raisedAt));
  unanswered.sort();
  return { rows, unanswered };
}

function newDeviceRow(hostId: string, computer: string, alert: NewDeviceAlertView): NewDeviceRow {
  const where = alert.kind === "hub-member" ? "joined the hub" : `paired with ${computer}`;
  return {
    key: `${hostId}:${String(alert.alertId)}`,
    computer,
    title: `${alert.name} ${where}`,
    detail: [alert.privateAddress, alert.kind === "hub-member" ? alert.role : "paired device"]
      .filter((part) => part !== undefined)
      .join(" · "),
    fingerprint:
      alert.kind === "hub-member" ? alert.identityKeyFingerprint : alert.deviceKeyFingerprint,
    raisedAt: String(alert.raisedAt),
  };
}
