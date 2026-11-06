import { expect, it } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  NIGHTLY_CLIENT_CHANNELS,
  NIGHTLY_CLIENT_PUSH_CHANNELS,
  nightlyClientChannelClass,
  nightlyClientChannelGaps,
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

it("names every answered channel the table does not mark local and every unanswered local one", () => {
  const local = Object.values(DESKTOP_IPC_CHANNELS).filter(
    (channel) =>
      nightlyClientChannelClass(channel) === "local" && !NIGHTLY_CLIENT_PUSH_CHANNELS.has(channel),
  );
  expect(nightlyClientChannelGaps(new Set(local), new Set())).toEqual({
    unmarked: [],
    unanswered: [],
  });
  const [withheld, ...rest] = local;
  if (withheld === undefined) throw new Error("No local channel");
  expect(nightlyClientChannelGaps(new Set(rest), new Set()).unanswered).toEqual([withheld]);
  expect(nightlyClientChannelGaps(new Set(rest), new Set([withheld])).unanswered).toEqual([]);
  expect(
    nightlyClientChannelGaps(
      new Set([...local, DESKTOP_IPC_CHANNELS.remotePairingTicket]),
      new Set(),
    ).unmarked,
  ).toEqual([DESKTOP_IPC_CHANNELS.remotePairingTicket]);
  for (const channel of NIGHTLY_CLIENT_PUSH_CHANNELS)
    expect(nightlyClientChannelClass(channel)).toBe("local");
});
