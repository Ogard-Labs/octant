import type { DeviceIntegritySignal } from "@octant/domain";

export interface MobileDeviceIntegrityPort {
  readonly probe: () => Promise<DeviceIntegritySignal>;
}

/** Stub until a platform integrity heuristic is wired on device builds. */
export function createUnavailableDeviceIntegrityPort(): MobileDeviceIntegrityPort {
  return {
    async probe() {
      return "unknown";
    },
  };
}
