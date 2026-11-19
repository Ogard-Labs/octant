import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubState, HubStatePort } from "../hub/hubStateStore";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { PairedDeviceAlerts } from "./pairedDeviceAlerts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function world() {
  const directory = mkdtempSync(join(tmpdir(), "octant-device-alerts-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-11-19T22:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-11-19T22:00:00.000Z",
  });
  let held: HubState = {};
  const state: HubStatePort = { load: () => held, save: (next) => void (held = next) };
  let n = 0;
  const alerts = new PairedDeviceAlerts({
    state,
    journal,
    connection,
    hostId: () => "11111111-1111-4111-8111-111111111111",
    localActorId: "66666666-6666-4666-8666-666666666666",
    uuid: () => `33333333-3333-4333-8333-${String((n += 1)).padStart(12, "0")}`,
    now: () => Date.parse("2026-11-19T22:00:00.000Z"),
  });
  const journaled = () =>
    connection
      .prepare(
        "SELECT event_name, payload_json FROM event_journal WHERE event_name = 'remote.device-alert-changed@1' ORDER BY global_sequence",
      )
      .all() as Array<{ readonly event_name: string; readonly payload_json: string }>;
  return { alerts, journaled };
}

const phone = {
  deviceId: "44444444-4444-4444-8444-444444444444",
  name: "Ada's phone",
  deviceKeyFingerprint: "d".repeat(64),
  privateAddress: "192.168.1.20",
};

describe("alerts for a device that paired directly with this host", () => {
  it("keeps the device's name and private address in the alert and never in the journal", () => {
    const { alerts, journaled } = world();
    alerts.raise(phone);
    expect(alerts.list()).toEqual([
      expect.objectContaining({
        deviceId: phone.deviceId,
        name: "Ada's phone",
        deviceKeyFingerprint: "d".repeat(64),
        privateAddress: "192.168.1.20",
      }),
    ]);
    const [raised] = journaled();
    expect(JSON.parse(raised?.payload_json ?? "{}")).toMatchObject({
      change: "raised",
      deviceId: phone.deviceId,
    });
    expect(raised?.payload_json).not.toContain("192.168.1.20");
    expect(raised?.payload_json).not.toContain("Ada");
  });

  it("clears an alert that is dismissed, or whose device is removed, and journals the dismissal", () => {
    const { alerts, journaled } = world();
    const first = alerts.raise(phone);
    alerts.raise({ ...phone, deviceId: "55555555-5555-4555-8555-555555555555", name: "Tablet" });
    expect(alerts.dismiss(String(first.alertId))).toEqual({ status: "dismissed" });
    expect(alerts.dismiss(String(first.alertId))).toEqual({ status: "refused", kind: "not-found" });
    alerts.dropDevice("55555555-5555-4555-8555-555555555555");
    expect(alerts.list()).toEqual([]);
    expect(journaled().map((row) => JSON.parse(row.payload_json).change)).toEqual([
      "raised",
      "raised",
      "dismissed",
      "dismissed",
    ]);
  });
});
