import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { MobileHostRegistration } from "../hosts/HostRegistry";
import type { MobileHostHealth } from "../session/MobileHostSessionHub";

// Kept apart from the fixtures so production code can resolve the scenario id
// without bundling the fixture data.
export type MobileMockScenarioId = "full" | "stale" | "empty";

export interface MobileMockScenario {
  readonly id: MobileMockScenarioId;
  readonly label: string;
  readonly hosts: ReadonlyArray<MobileHostRegistration>;
  readonly health: ReadonlyArray<MobileHostHealth>;
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
}

export function resolveMobileMockScenario(
  configured: unknown,
  isDevelopment: boolean,
): MobileMockScenarioId | undefined {
  if (!isDevelopment) return undefined;
  return configured === "full" || configured === "stale" || configured === "empty"
    ? configured
    : undefined;
}
