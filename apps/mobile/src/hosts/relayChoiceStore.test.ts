import { decodeRelayAddress } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createInMemoryMobileHostRegistryStorage } from "./HostRegistry";
import { createRelayChoiceStore } from "./relayChoiceStore";

describe("the phone's relay choices", () => {
  it("keeps a forgotten computer forgotten while another computer's address is being saved", async () => {
    const choices = createRelayChoiceStore(createInMemoryMobileHostRegistryStorage());
    const forgotten = "https://100.101.102.103:8443";
    const other = "https://100.101.102.104:8443";
    const address = decodeRelayAddress({
      hubMemberId: "11111111-1111-4111-8111-111111111111",
      relayUrl: "wss://hub.example.com/relay/v1",
    });
    await choices.setEnabled(forgotten, true);

    await Promise.all([choices.forget(forgotten), choices.rememberAddress(other, address)]);

    expect(await choices.read(forgotten)).toBeUndefined();
    expect(await choices.read(other)).toEqual({ enabled: false, address });
  });
});
