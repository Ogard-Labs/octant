import { SPEECH_LOCAL_WAV_HEADER_BYTES } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeLocalClip, toLocalClip } from "./localClip";

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await new Response(blob).arrayBuffer());
}

function text(view: DataView, start: number, end: number): string {
  return String.fromCharCode(...new Uint8Array(view.buffer, start, end - start));
}

afterEach(() => vi.unstubAllGlobals());

describe("clip for the on-device engine", () => {
  it("is a plain 16 kHz mono 16-bit WAV of exactly the samples", async () => {
    const view = await bytesOf(encodeLocalClip([Float32Array.from([0, 1, -1, 0.5])]));
    expect(view.byteLength).toBe(SPEECH_LOCAL_WAV_HEADER_BYTES + 8);
    expect(text(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
    expect(text(view, 8, 16)).toBe("WAVEfmt ");
    expect([16, 24, 28, 40].map((offset) => view.getUint32(offset, true))).toEqual([
      16, 16_000, 32_000, 8,
    ]);
    expect([20, 22, 32, 34].map((offset) => view.getUint16(offset, true))).toEqual([1, 1, 2, 16]);
    expect(text(view, 36, 40)).toBe("data");
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([
      0, 32_767, -32_768, 16_383,
    ]);
  });

  it("mixes channels to one and never wraps a sample past full scale", async () => {
    const view = await bytesOf(
      encodeLocalClip([Float32Array.from([1, 3]), Float32Array.from([0, 3])]),
    );
    expect([44, 46].map((offset) => view.getInt16(offset, true))).toEqual([16_383, 32_767]);
  });

  it("decodes the recording at the engine's rate", async () => {
    const rates: Array<number> = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor(_channels: number, _length: number, rate: number) {
          rates.push(rate);
        }
        async decodeAudioData() {
          return {
            numberOfChannels: 1,
            getChannelData: () => Float32Array.from([0.25]),
          };
        }
      },
    );
    const clip = await toLocalClip(new Blob([Uint8Array.from([1, 2, 3])]));
    expect(rates).toEqual([16_000]);
    expect(clip.size).toBe(SPEECH_LOCAL_WAV_HEADER_BYTES + 2);
  });
});
