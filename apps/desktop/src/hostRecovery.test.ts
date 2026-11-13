import { describe, expect, it } from "vitest";
import {
  decodeHostRecoveryAction,
  describeHostMaintenanceOutcome,
  hostMaintenanceSpawnSpec,
  hostRecoveryActionUrl,
  hostRecoveryScreenFor,
  readHostStartupRefusal,
  renderHostRecoveryDocument,
} from "./hostRecovery";
import { createStderrTail, ServerExitedBeforeReady } from "./serverProcess";

function refusedStart(line: string): ServerExitedBeforeReady {
  return new ServerExitedBeforeReady(1, null, `starting\n${line}`);
}

describe("host recovery", () => {
  it("reads the host's refusal record from the last output of a refused start", () => {
    const error = refusedStart(
      '{"product":"Octant","status":"failed","category":"recovery-required","message":"Octant storage requires recovery before startup.","recovery":"store-damaged"}',
    );

    expect(readHostStartupRefusal(error)).toEqual({
      category: "recovery-required",
      message: "Octant storage requires recovery before startup.",
      recovery: "store-damaged",
    });
  });

  it("still reads the refusal record after the stderr tail redacts it", () => {
    const tail = createStderrTail();
    tail.append(
      '{"product":"Octant","status":"failed","category":"storage-unavailable","message":"Octant storage is unavailable: the disk is full."}\n',
    );

    expect(readHostStartupRefusal(new ServerExitedBeforeReady(1, null, tail.text()))).toEqual({
      category: "storage-unavailable",
      message: "Octant storage is unavailable: the disk is full.",
    });
  });

  it("keeps the plain error for a start that printed no refusal record", () => {
    expect(readHostStartupRefusal(refusedStart("Segmentation fault"))).toBeUndefined();
    expect(readHostStartupRefusal(refusedStart('{"status":"failed"}'))).toBeUndefined();
    expect(readHostStartupRefusal("not an error")).toBeUndefined();
  });

  it("offers rebuild and restore only for a damaged store", () => {
    const damaged = hostRecoveryScreenFor({
      category: "recovery-required",
      message: "Octant storage requires recovery before startup.",
      recovery: "store-damaged",
    });
    expect(damaged.actions).toEqual(["rebuild", "restore", "retry", "quit"]);

    for (const refusal of [
      { category: "recovery-required", message: "m", recovery: "removal-unfinished" as const },
      { category: "migration-incompatible", message: "m" },
      { category: "storage-busy", message: "m" },
      { category: "storage-unavailable", message: "m" },
      { category: "server-unavailable", message: "m" },
    ]) {
      expect(hostRecoveryScreenFor(refusal).actions).toEqual(["retry", "quit"]);
    }
  });

  it("names no command a person cannot run from the app", () => {
    for (const category of [
      "recovery-required",
      "migration-incompatible",
      "storage-busy",
      "storage-unavailable",
      "startup-failed",
    ]) {
      const screen = hostRecoveryScreenFor({ category, message: "" });
      expect(`${screen.heading} ${screen.explanation}`).not.toMatch(/db:|bun run|snapshot/);
    }
  });

  it("asks for a restore only with the explicit confirmation flag", () => {
    const spec = hostMaintenanceSpawnSpec({
      packaged: true,
      root: "/Applications/Octant.app/Contents/Resources/app",
      execPath: "/Applications/Octant.app/Contents/MacOS/Octant",
      env: { OCTANT_DATA_DIR: "/data" },
      action: "restore",
    });

    expect(spec.args).toEqual([
      "/Applications/Octant.app/Contents/Resources/app/apps/server/dist/dbMaintenance.mjs",
      "restore",
      "--confirm",
    ]);
    expect(spec.env).toMatchObject({ OCTANT_DATA_DIR: "/data", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("shows the maintenance command's own fixed refusal, or one generic sentence", () => {
    expect(
      describeHostMaintenanceOutcome(
        "restore",
        1,
        JSON.stringify({
          ok: false,
          error: {
            category: "backup-unverified",
            message: "The Octant backup could not be verified.",
          },
        }),
      ),
    ).toEqual({ status: "refused", message: "The Octant backup could not be verified." });
    expect(describeHostMaintenanceOutcome("rebuild", 1, "panic at /Users/me/x")).toEqual({
      status: "refused",
      message: "Octant could not rebuild its data. Nothing was changed.",
    });
    expect(describeHostMaintenanceOutcome("rebuild", 0, "").status).toBe("repaired");
  });

  it("accepts only its own action links", () => {
    expect(decodeHostRecoveryAction(hostRecoveryActionUrl("rebuild"))).toBe("rebuild");
    expect(decodeHostRecoveryAction(hostRecoveryActionUrl("export"))).toBe("export");
    expect(decodeHostRecoveryAction("octant-recovery://reset")).toBeUndefined();
    expect(decodeHostRecoveryAction("https://example.com/rebuild")).toBeUndefined();
  });

  it("renders a script-free page that escapes the host's message", () => {
    const html = renderHostRecoveryDocument(
      hostRecoveryScreenFor({ category: "startup-failed", message: "<img src=x>" }),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain(hostRecoveryActionUrl("retry"));
    expect(html).toContain(hostRecoveryActionUrl("export"));
  });
});
