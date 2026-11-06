import { expect, it } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  NIGHTLY_CLIENT_CHANNELS,
  nightlyClientChannelClass,
  nightlyClientRefusal,
} from "./nightlyClientChannels";

it("classifies every desktop channel, and nothing that is not one", () => {
  expect(Object.keys(NIGHTLY_CLIENT_CHANNELS).sort()).toEqual(
    Object.keys(DESKTOP_IPC_CHANNELS).sort(),
  );
  for (const channelClass of Object.values(NIGHTLY_CLIENT_CHANNELS))
    expect(["local", "brokered", "octant-only", "replaced"]).toContain(channelClass);
});

it("keeps remote access, pairing, hubs, owner unlock and host identity in Octant", () => {
  for (const channel of [
    DESKTOP_IPC_CHANNELS.privateListenerEnable,
    DESKTOP_IPC_CHANNELS.remotePairingTicket,
    DESKTOP_IPC_CHANNELS.remoteDeviceRevokeAll,
    DESKTOP_IPC_CHANNELS.hubAdministrationRequest,
    DESKTOP_IPC_CHANNELS.ownerUnlockSign,
    DESKTOP_IPC_CHANNELS.remoteHostIdentityRotate,
    DESKTOP_IPC_CHANNELS.pairedComputerPair,
    DESKTOP_IPC_CHANNELS.remoteServerPageOpen,
    DESKTOP_IPC_CHANNELS.nightlyInstall,
  ])
    expect(nightlyClientChannelClass(channel)).toBe("octant-only");
  expect(nightlyClientChannelClass("octant:unlisted")).toBe("octant-only");
});

it("says where each refused class lives and never blames the Octant version", () => {
  expect(nightlyClientRefusal("octant-only")).toMatch(/^Managed in Octant\./);
  expect(nightlyClientRefusal("brokered")).toBe("Not available in Octant Nightly yet.");
  expect(nightlyClientRefusal("local")).toBe("Not available in Octant Nightly yet.");
  expect(nightlyClientRefusal("replaced")).toMatch(/Browser presentation/);
  for (const channelClass of ["local", "brokered", "octant-only", "replaced"] as const)
    expect(nightlyClientRefusal(channelClass)).not.toMatch(/newer Octant/);
});
