import { describe, expect, it } from "vitest";
import {
  authorizeHostControlAction,
  deriveHostLifecycleControls,
  HOST_CONTROL_ACTION_NAMES,
} from "./hostControlPolicy";

describe("authorizeHostControlAction", () => {
  it("maps every host control operation to a catalogued local-host action", () => {
    expect(HOST_CONTROL_ACTION_NAMES).toEqual({
      status: "host.service.status",
      stop: "host.service.stop",
      restart: "host.service.restart",
      enable: "host.service.enable",
      disable: "host.service.disable",
      backup: "host.store.backup",
      restore: "host.store.restore",
    });
  });

  it.each(["status", "stop", "restart", "enable", "disable", "backup", "restore"] as const)(
    "allows a local window and denies a remote device for %s",
    (operation) => {
      expect(authorizeHostControlAction({ principalKind: "local-window", operation })).toEqual({
        kind: "allow",
      });
      expect(authorizeHostControlAction({ principalKind: "remote-device", operation })).toEqual({
        kind: "deny",
        reason: "local-host-required",
      });
    },
  );
});

describe("deriveHostLifecycleControls", () => {
  const knownPolicy = { kind: "known" as const, enabled: true };

  it("offers stop, enable, and disable to a local principal on every owner mode", () => {
    for (const serviceMode of ["desktop", "foreground", "web", "service"] as const) {
      const controls = deriveHostLifecycleControls({ serviceMode, policy: knownPolicy });
      expect(controls.stop).toEqual({ kind: "available" });
      expect(controls.enable).toEqual({ kind: "available" });
      expect(controls.disable).toEqual({ kind: "available" });
    }
  });

  it("offers restart only when a per-user service manager owns the process", () => {
    expect(
      deriveHostLifecycleControls({ serviceMode: "service", policy: knownPolicy }).restart,
    ).toEqual({ kind: "available" });
    for (const serviceMode of ["desktop", "foreground", "web"] as const) {
      const restart = deriveHostLifecycleControls({ serviceMode, policy: knownPolicy }).restart;
      expect(restart.kind).toBe("unavailable");
      if (restart.kind === "unavailable") {
        expect(restart.reason).toContain("octant server restart");
      }
    }
  });

  it("withholds policy mutations when the service policy is unavailable", () => {
    const controls = deriveHostLifecycleControls({
      serviceMode: "service",
      policy: { kind: "unavailable" },
    });
    expect(controls.enable.kind).toBe("unavailable");
    expect(controls.disable.kind).toBe("unavailable");
    expect(controls.stop).toEqual({ kind: "available" });
  });
});
