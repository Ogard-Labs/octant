import { describe, expect, it, vi } from "vitest";
import { serveAvdFromEnvironment } from "./serveAvdBrokerClient";

const token = "a".repeat(43);
const endpoint = "http://127.0.0.1:44000/v1/managed-device/serve-avd";

describe("serve-avd broker client", () => {
  it("is absent unless the desktop handed over a loopback broker", () => {
    expect(serveAvdFromEnvironment({})).toBeUndefined();
    expect(
      serveAvdFromEnvironment({
        OCTANT_SERVE_AVD_BROKER_URL: "http://192.168.1.8/v1/managed-device/serve-avd",
        OCTANT_SERVE_AVD_BROKER_TOKEN: token,
      }),
    ).toBeUndefined();
    expect(
      serveAvdFromEnvironment({
        OCTANT_SERVE_AVD_BROKER_URL: endpoint,
        OCTANT_SERVE_AVD_BROKER_TOKEN: "short",
      }),
    ).toBeUndefined();
  });

  it("accepts a loopback stream for the requested serial and refuses any other host", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        origin: "http://127.0.0.1:9",
        streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
      }),
    );
    const port = serveAvdFromEnvironment(
      {
        OCTANT_SERVE_AVD_BROKER_URL: endpoint,
        OCTANT_SERVE_AVD_BROKER_TOKEN: token,
      },
      fetchImpl,
    );
    expect(port).toBeDefined();
    await expect(port?.open("Pixel_9")).resolves.toBeUndefined();
    await expect(port?.open("emulator-5554")).resolves.toEqual({
      origin: "http://127.0.0.1:9",
      streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ serial: "emulator-5554" }),
      }),
    );

    const remote = serveAvdFromEnvironment(
      {
        OCTANT_SERVE_AVD_BROKER_URL: endpoint,
        OCTANT_SERVE_AVD_BROKER_TOKEN: token,
      },
      async () =>
        Response.json({
          origin: "http://127.0.0.1:9",
          streamUrl: "http://192.168.1.8:9/helper/emulator-5554/stream.mjpeg",
        }),
    );
    await expect(remote?.open("emulator-5554")).resolves.toBeUndefined();
  });
});
