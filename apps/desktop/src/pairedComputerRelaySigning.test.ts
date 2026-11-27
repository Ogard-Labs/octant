import { describe, expect, it } from "vitest";
import type { PairedComputerRelaySigningRequest } from "@octant/contracts/desktop-bridge";
import { PairedComputerRelaySigning } from "./pairedComputerRelaySigning";

const ORIGIN = "https://laptop.tail1234.ts.net:8443";
const HOST = "22222222-2222-4222-8222-222222222222";
const HUB = "11111111-1111-4111-8111-111111111111";
const PAYLOAD = `octant/relay/v1|${"A".repeat(43)}|${HOST}|${HUB}`;
const ANSWER = { signature: "s".repeat(86), deviceSpki: "k".repeat(91) };

function signing(timeoutMs = 1_000) {
  const asked: Array<{ window: string; request: PairedComputerRelaySigningRequest }> = [];
  let next = 0;
  const broker = new PairedComputerRelaySigning<string>({
    send: (window, request) => asked.push({ window, request }),
    newId: () => `request-${(next += 1)}`,
    timeoutMs,
  });
  return { broker, asked };
}

describe("asking the window to sign a relay admission", () => {
  it("asks the window that sent the request, and takes its signature", async () => {
    const { broker, asked } = signing();
    const signed = broker.ask("window-1", { origin: ORIGIN, hostId: HOST, payload: PAYLOAD });
    expect(asked).toEqual([
      { window: "window-1", request: { requestId: "request-1", origin: ORIGIN, payload: PAYLOAD } },
    ]);
    expect(broker.answer("window-1", { requestId: "request-1", ...ANSWER })).toBe(true);
    await expect(signed).resolves.toEqual(ANSWER);
  });

  it("never asks the window to sign anything but the exact admission for that computer", async () => {
    const { broker, asked } = signing();
    for (const payload of [
      "POST\n/api/remote/auth/session\n{}",
      `${PAYLOAD}|`,
      `octant/relay/v1|${"A".repeat(43)}|${HUB}|${HUB}`,
      `octant/relay/v1|${"A".repeat(42)}|${HOST}|${HUB}`,
    ]) {
      await expect(
        broker.ask("window-1", { origin: ORIGIN, hostId: HOST, payload }),
      ).rejects.toThrow("only a relay admission");
    }
    expect(asked).toEqual([]);
  });

  it("takes no answer from another window, and none that is malformed", async () => {
    const { broker } = signing();
    const signed = broker.ask("window-1", { origin: ORIGIN, hostId: HOST, payload: PAYLOAD });
    expect(broker.answer("window-2", { requestId: "request-1", ...ANSWER })).toBe(false);
    expect(
      broker.answer("window-1", { requestId: "request-1", signature: "x", deviceSpki: "y" }),
    ).toBe(true);
    await expect(signed).rejects.toThrow("did not sign");
  });

  it("gives up when the window does not answer in time", async () => {
    const { broker } = signing(10);
    await expect(
      broker.ask("window-1", { origin: ORIGIN, hostId: HOST, payload: PAYLOAD }),
    ).rejects.toThrow("did not sign");
  });
});
