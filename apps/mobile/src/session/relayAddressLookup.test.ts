import { decodeRelayAddress } from "@octant/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryMobileHostRegistryStorage } from "../hosts/HostRegistry";
import { createRelayChoiceStore } from "../hosts/relayChoiceStore";
import { createRelayAddressLookup, RELAY_ADDRESS_REFRESH_MS } from "./relayAddressLookup";

const ORIGIN = "https://100.101.102.103:8443";
const ADDRESS = decodeRelayAddress({
  hubMemberId: "11111111-1111-4111-8111-111111111111",
  relayUrl: "wss://hub.example.com/relay/v1",
});

/** One paired computer, connected from the start, that answers as `allowed` says. */
function pairedComputer() {
  let allowed = false;
  let connected = true;
  let asked = 0;
  const listeners = new Set<() => void>();
  const connection = {
    authenticatedFetch: async () => {
      asked += 1;
      return Response.json(
        allowed ? { status: "available", ...ADDRESS } : { status: "unavailable" },
      );
    },
  };
  const hub = {
    slots: () => [
      {
        registration: { origin: ORIGIN },
        state: { kind: connected ? "ready" : "reconnecting" },
        bridge: { connection: () => (connected ? connection : undefined) },
      },
    ],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const lookup = createRelayAddressLookup({
    hub,
    choices: createRelayChoiceStore(createInMemoryMobileHostRegistryStorage()),
  });
  return {
    lookup,
    emit,
    asked: () => asked,
    allow: () => {
      allowed = true;
    },
    reconnect: () => {
      connected = false;
      emit();
      connected = true;
      emit();
    },
    address: async () => (await lookup.choices.read(ORIGIN))?.address,
  };
}

/** Lets the answers in flight reach the store. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("learning where a computer's hub relays", () => {
  /** Paired and connected while the computer does not yet let the phone through. */
  async function connectedBeforeApproval() {
    const computer = pairedComputer();
    const stop = computer.lookup.start();
    await settle();
    expect(computer.asked()).toBe(1);
    expect(await computer.address()).toBeUndefined();
    computer.allow();
    return { ...computer, stop };
  }

  it("asks again when the person turns the switch on", async () => {
    const computer = await connectedBeforeApproval();
    await computer.lookup.choices.setEnabled(ORIGIN, true);
    await settle();
    expect(await computer.address()).toEqual(ADDRESS);
    computer.stop();
  });

  it("asks again when the connection comes back", async () => {
    const computer = await connectedBeforeApproval();
    computer.reconnect();
    await settle();
    expect(await computer.address()).toEqual(ADDRESS);
    computer.stop();
  });

  it("asks again every ten minutes while connected, and not on every session change", async () => {
    const computer = await connectedBeforeApproval();
    computer.emit();
    computer.emit();
    await settle();
    expect(computer.asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(RELAY_ADDRESS_REFRESH_MS);
    expect(await computer.address()).toEqual(ADDRESS);
    computer.stop();
    await vi.advanceTimersByTimeAsync(RELAY_ADDRESS_REFRESH_MS);
    expect(computer.asked()).toBe(2);
  });
});
