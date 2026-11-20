import type { MobileRemoteTransport } from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import { readNewDevicesAcross } from "./newDevices";

const studio = "11111111-1111-4111-8111-111111111111";
const laptop = "22222222-2222-4222-8222-222222222222";

function computer(hostId: string, answer: () => Response): MobileRemoteTransport {
  return { hostId, authenticatedFetch: vi.fn(async () => answer()) };
}

describe("the phone's list of new devices", () => {
  it("lists every computer's new devices, newest first, with each one's address", async () => {
    const reading = await readNewDevicesAcross({
      transports: [
        computer(studio, () =>
          Response.json({
            alerts: [
              {
                kind: "paired-device",
                alertId: "00000000-0000-4000-8000-000000000b01",
                deviceId: "00000000-0000-4000-8000-000000000b02",
                name: "Ada's laptop",
                deviceKeyFingerprint: "d".repeat(64),
                raisedAt: "2026-11-20T08:05:00.000Z",
                privateAddress: "192.168.1.20",
              },
            ],
            removesHere: false,
          }),
        ),
        computer(laptop, () =>
          Response.json({
            alerts: [
              {
                kind: "hub-member",
                alertId: "00000000-0000-4000-8000-000000000a01",
                name: "Tablet",
                role: "spoke",
                identityKeyFingerprint: "c".repeat(64),
                raisedAt: "2026-11-20T08:00:00.000Z",
              },
            ],
            removesHere: false,
          }),
        ),
      ],
      computerName: (hostId) => (hostId === studio ? "Studio Mac" : "Laptop"),
    });
    expect(reading.rows.map((row) => [row.title, row.detail])).toEqual([
      ["Ada's laptop paired with Studio Mac", "192.168.1.20 · paired device"],
      ["Tablet joined the hub", "spoke"],
    ]);
    expect(reading.unanswered).toEqual([]);
  });

  it("names a computer that did not answer instead of reading it as having none", async () => {
    const reading = await readNewDevicesAcross({
      transports: [computer(studio, () => new Response("no", { status: 503 }))],
      computerName: () => "Studio Mac",
    });
    expect(reading).toEqual({ rows: [], unanswered: ["Studio Mac"] });
  });
});
