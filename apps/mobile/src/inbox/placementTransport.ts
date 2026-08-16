import type { MobileRemoteTransport } from "@octant/client-runtime";

export function selectMobilePlacementTransport(input: {
  readonly placementHostId: string | undefined;
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
  readonly transportForHost: (hostId: string) => MobileRemoteTransport | undefined;
}): MobileRemoteTransport | undefined {
  if (input.placementHostId !== undefined) {
    return input.transportForHost(input.placementHostId);
  }
  return input.transports[0];
}
