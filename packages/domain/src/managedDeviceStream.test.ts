import { describe, expect, it } from "vitest";
import {
  readManagedDeviceEndpoint,
  takeJpegFrames,
  takeMultipartImageFrames,
} from "./managedDeviceStream";

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
  it("takes PNG and JPEG parts from a multipart stream by their length, across chunks", () => {
    // serve-avd sends PNG parts when the emulator image cannot encode `screencap -j`.
    // A PNG's compressed bytes can contain FF D8 and FF D9, so parts are cut by
    // Content-Length, not by JPEG markers.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd9, 0x00]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const stream = joined(part("image/png", png), part("image/jpeg", jpeg));
    const cut = 30;
    const first = takeMultipartImageFrames(stream.subarray(0, cut));
    expect(first.frames).toEqual([]);
    const second = takeMultipartImageFrames(joined(first.rest, stream.subarray(cut)));
    expect(second.frames).toEqual([png, jpeg]);
    expect(second.rest).toEqual(new Uint8Array());
  });

  it("drops a part that is not an image or is larger than a frame may be", () => {
    const text = new TextEncoder().encode("not an image");
    const jpeg = Uint8Array.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);
    expect(
      takeMultipartImageFrames(joined(part("text/plain", text), part("image/jpeg", jpeg))).frames,
    ).toEqual([jpeg]);
    const oversized = new TextEncoder().encode(
      "--frame\r\nContent-Type: image/png\r\nContent-Length: 99999999\r\n\r\n",
    );
    expect(takeMultipartImageFrames(oversized)).toEqual({ frames: [], rest: new Uint8Array() });
  });
});

function part(type: string, body: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(
    `--frame\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  return joined(header, body, new TextEncoder().encode("\r\n"));
}

function joined(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of parts) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}
