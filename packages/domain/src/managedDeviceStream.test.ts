import { describe, expect, it } from "vitest";
import { readManagedDeviceEndpoint, takeJpegFrames } from "./managedDeviceStream";

const device = "emulator-5554";
const streamUrl = `http://127.0.0.1:3100/helper/${device}/stream.mjpeg`;

describe("managed device streams", () => {
  it("accepts the tool's loopback stream for the requested device", () => {
    expect(
      readManagedDeviceEndpoint(
        JSON.stringify({
          device,
          url: "http://127.0.0.1:3100",
          streamUrl,
          wsUrl: "ws://127.0.0.1:3100/helper/emulator-5554/ws",
        }),
        device,
      ),
    ).toEqual({ origin: "http://127.0.0.1:3100", streamUrl });
  });

  it("refuses a stream that leaves the machine or names another device", () => {
    expect(
      readManagedDeviceEndpoint(
        JSON.stringify({
          device,
          url: "http://127.0.0.1:3100",
          streamUrl: "http://192.168.1.8:3100/helper/emulator-5554/stream.mjpeg",
        }),
        device,
      ),
    ).toBeUndefined();
    expect(
      readManagedDeviceEndpoint(
        JSON.stringify({
          device: "emulator-5556",
          url: "http://127.0.0.1:3100",
          streamUrl: "http://127.0.0.1:3100/helper/emulator-5556/stream.mjpeg",
        }),
        device,
      ),
    ).toBeUndefined();
  });

  it("splits raw and multipart JPEG frames and keeps a partial frame", () => {
    const first = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const second = Uint8Array.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const header = new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\n\r\n");
    const multipart = new Uint8Array(header.length + first.length + 2 + second.length);
    multipart.set(header);
    multipart.set(first, header.length);
    multipart.set(new TextEncoder().encode("\r\n"), header.length + first.length);
    multipart.set(second, header.length + first.length + 2);
    const split = takeJpegFrames(multipart.subarray(0, multipart.length - 1));
    expect(split.frames).toEqual([first]);
    const rest = takeJpegFrames(concat(split.rest, multipart.subarray(multipart.length - 1)));
    expect(rest.frames).toEqual([second]);
    expect(rest.rest).toEqual(new Uint8Array());
  });
});

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}
