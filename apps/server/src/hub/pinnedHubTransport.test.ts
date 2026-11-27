import { createServer, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenerPinFromDigest } from "./hubCrypto";
import { createPinnedHubTransport, SYSTEM_NETWORK, type HubNetwork } from "./pinnedHubTransport";

const ORIGIN = "https://100.101.102.103:8443";
const PIN = listenerPinFromDigest("ab".repeat(32));

/** A network whose dial never connects, as to a host that drops packets silently; a late socket is recorded. */
function silentNetwork() {
  let connect: ((socket: Socket) => void) | undefined;
  let attempt: AbortSignal | undefined;
  const late = new Socket();
  const destroyed = vi.spyOn(late, "destroy");
  const network: HubNetwork = {
    resolve: async () => ["100.101.102.103"],
    dial: (_address, _port, signal) =>
      new Promise<Socket>((resolve) => {
        attempt = signal;
        connect = resolve;
      }),
  };
  return {
    network,
    destroyed,
    dialling: () => connect !== undefined,
    attemptAborted: () => attempt?.aborted === true,
    connectLate: () => connect?.(late),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a pinned request to a listener that never answers the dial", () => {
  it("ends when the request is aborted, and closes a connection that arrives later", async () => {
    const silent = silentNetwork();
    const controller = new AbortController();
    const fetch = createPinnedHubTransport(silent.network)({ origin: ORIGIN, pin: PIN });
    const answer = fetch(`${ORIGIN}/status`, { signal: controller.signal });
    await vi.waitFor(() => expect(silent.dialling()).toBe(true));
    controller.abort(new Error("deadline"));
    await expect(answer).rejects.toThrow("deadline");
    expect(silent.attemptAborted()).toBe(true);
    silent.connectLate();
    await vi.waitFor(() => expect(silent.destroyed).toHaveBeenCalled());
  });

  it("gives up on its own after the dial timeout, without a signal", async () => {
    vi.useFakeTimers();
    const silent = silentNetwork();
    const fetch = createPinnedHubTransport(silent.network)({ origin: ORIGIN, pin: PIN });
    const answer = fetch(`${ORIGIN}/status`);
    const settled = expect(answer).rejects.toThrow("dial timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(silent.attemptAborted()).toBe(true);
  });
});

describe("the system network's dial", () => {
  it("closes a connection still being made when its attempt is aborted", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const attempt = new AbortController();
      const dialled = SYSTEM_NETWORK.dial("127.0.0.1", address.port, attempt.signal);
      attempt.abort(new Error("gave up"));
      await expect(dialled).rejects.toThrow("gave up");
      await vi.waitFor(async () => {
        const open = await new Promise<number>((resolve, reject) =>
          server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
        );
        expect(open).toBe(0);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
