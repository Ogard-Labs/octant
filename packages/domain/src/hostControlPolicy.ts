import type { HostLifecycleControlAvailability } from "@octant/contracts/host-control";
import {
  authorizePrincipalAction,
  type PrincipalActionDecision,
  type PrincipalKind,
} from "./remoteAccessPolicy";

/**
 * Pure host-control authority and lifecycle-availability policy for the
 * shared web Settings host card (Headless A4). Transport routes in
 * `apps/server` must consult this module before any lifecycle, policy,
 * backup, or restore side effect; a caller that mutates host state without an
 * `allow` from {@link authorizeHostControlAction} is a defect.
 */

export type HostControlOperation =
  | "status"
  | "data-map"
  | "stop"
  | "restart"
  | "enable"
  | "disable"
  | "backup"
  | "restore"
  | "retention"
  | "purge"
  | "export"
  | "memory-limits";

/**
 * Canonical least-authority catalogue names for every host control
 * operation. Reusing the shared remote-access catalogue keeps one source of
 * truth: a remote device is denied here for exactly the same reason it is
 * denied at the remote gateway.
 */
export const HOST_CONTROL_ACTION_NAMES: Readonly<Record<HostControlOperation, string>> = {
  status: "host.service.status",
  "data-map": "host.store.data-map",
  stop: "host.service.stop",
  restart: "host.service.restart",
  enable: "host.service.enable",
  disable: "host.service.disable",
  backup: "host.store.backup",
  restore: "host.store.restore",
  retention: "host.store.retention",
  purge: "host.store.purge",
  export: "host.store.export",
  "memory-limits": "host.service.memory-limits",
};

export function authorizeHostControlAction(input: {
  readonly principalKind: PrincipalKind;
  readonly operation: HostControlOperation;
}): PrincipalActionDecision {
  return authorizePrincipalAction({
    principalKind: input.principalKind,
    action: HOST_CONTROL_ACTION_NAMES[input.operation],
  });
}

export type HostControlServiceModeInput = "desktop" | "foreground" | "web" | "service";

export interface HostLifecycleControlsInput {
  readonly serviceMode: HostControlServiceModeInput;
  readonly policy:
    | { readonly kind: "known"; readonly enabled: boolean }
    | { readonly kind: "unavailable" };
  /**
   * What starts the host again. `restarts` (the default) is launchd or a
   * systemd user unit. `logon-entry` is the Windows Run value, which starts
   * the host only at sign-in and is itself the startup policy.
   */
  readonly supervisor?: "restarts" | "logon-entry";
}

export interface HostLifecycleControls {
  readonly stop: HostLifecycleControlAvailability;
  readonly restart: HostLifecycleControlAvailability;
  readonly enable: HostLifecycleControlAvailability;
  readonly disable: HostLifecycleControlAvailability;
}

const AVAILABLE: HostLifecycleControlAvailability = { kind: "available" };

/**
 * Honest lifecycle-control availability for one running owner.
 *
 * - `stop` is always available to an authorized local principal: every owner
 *   mode supports an authenticated graceful drain.
 * - `restart` is available only when a per-user service manager owns the
 *   process and will start it again after the drain. A desktop, foreground,
 *   or web owner has no supervisor, so the web surface reports the exact CLI
 *   recovery path instead of pretending.
 * - `enable`/`disable` mutate the persisted service policy and are withheld
 *   when that policy cannot be read, never guessed.
 * - A Windows logon entry restarts nothing (a drain would leave the host
 *   down until sign-in) and is changed by the CLI that wrote its command,
 *   so both stay with `octant server` there.
 */
export function deriveHostLifecycleControls(
  input: HostLifecycleControlsInput,
): HostLifecycleControls {
  if (input.supervisor === "logon-entry") {
    const startup: HostLifecycleControlAvailability = {
      kind: "unavailable",
      reason:
        "On Windows, automatic startup is the logon entry the CLI writes. Use `octant server enable` or `octant server disable` from a local terminal.",
    };
    return {
      stop: AVAILABLE,
      restart: {
        kind: "unavailable",
        reason:
          "On Windows nothing starts the host again until sign-in. Use `octant server restart` from a local terminal.",
      },
      enable: startup,
      disable: startup,
    };
  }
  const policyMutation: HostLifecycleControlAvailability =
    input.policy.kind === "known"
      ? AVAILABLE
      : {
          kind: "unavailable",
          reason: "The service policy could not be read, so startup policy cannot change here.",
        };
  return {
    stop: AVAILABLE,
    restart:
      input.serviceMode === "service"
        ? AVAILABLE
        : {
            kind: "unavailable",
            reason:
              "Restart requires the per-user service manager. Use `octant server restart` from a local terminal.",
          },
    enable: policyMutation,
    disable: policyMutation,
  };
}
