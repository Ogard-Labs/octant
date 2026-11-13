import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedHostLogStore, recordHostCrash } from "@octant/host-runtime";
import { describe, expect, it } from "vitest";
import { buildRecoverySupportBundle } from "./recoverySupportBundle";

const HOME = "/Users/ada";
const SECRET = "sk-abcdefghijklmnop1234";

describe("recovery support bundle", () => {
  it("holds the crash records and host log, redacted, and marks host-only sections not available", async () => {
    const data = await mkdtemp(join(tmpdir(), "octant-recovery-bundle-"));
    const serviceLogPath = join(data, "logs", "service.log");
    await recordHostCrash(data, {
      recordedAt: "2026-11-13T10:00:00.000Z",
      process: "host",
      exitReason: "exit code 1",
      lastLines: ["store refused to open"],
    });
    await new BoundedHostLogStore({ path: serviceLogPath }).append({
      timestamp: "2026-11-13T09:59:00.000Z",
      level: "error",
      event: "store.refused",
      message: `opening ${HOME}/Library/octant with api_key=${SECRET}`,
    });

    const zip = await buildRecoverySupportBundle({
      bundleId: "00000000-0000-4000-8000-0000000000b1",
      now: new Date("2026-11-13T10:01:00.000Z"),
      octantVersion: "0.9.0-test",
      runtime: "electron test",
      dataDirectory: data,
      serviceLogPath,
      homeDirectory: HOME,
    });
    // A stored zip keeps each file's text as it is, so the bytes read as text.
    const text = new TextDecoder().decode(zip);

    expect(text).toContain("crash-records.json");
    expect(text).toContain("exit code 1");
    expect(text).toContain("store.refused");
    expect(text).toContain("~/Library/octant");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HOME);
    expect(text).toContain("providers.json: Providers.");
    expect(text).toMatch(/providers\.json[^\n]*\(not available\)/);
  });
});
