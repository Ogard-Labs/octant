import { describe, expect, it } from "vitest";
import { sniffSpeechAudioMediaType } from "./speechAudio";

function bytes(...parts: ReadonlyArray<string | ReadonlyArray<number>>): Uint8Array {
  const out: Array<number> = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  while (out.length < 16) out.push(0);
  return Uint8Array.from(out);
}

describe("sniffSpeechAudioMediaType", () => {
  it("identifies the container by its bytes, not by any declared type", () => {
    expect(sniffSpeechAudioMediaType(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "))).toBe("audio/wav");
    expect(sniffSpeechAudioMediaType(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe("audio/webm");
    expect(sniffSpeechAudioMediaType(bytes("OggS"))).toBe("audio/ogg");
    expect(sniffSpeechAudioMediaType(bytes("fLaC"))).toBe("audio/flac");
    expect(sniffSpeechAudioMediaType(bytes([0, 0, 0, 0x18], "ftypM4A "))).toBe("audio/mp4");
    expect(sniffSpeechAudioMediaType(bytes("ID3"))).toBe("audio/mpeg");
    expect(sniffSpeechAudioMediaType(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
  });

  it("refuses text, images, and clips too short to carry a header", () => {
    expect(sniffSpeechAudioMediaType(bytes('{"text":"hello"}'))).toBeUndefined();
    expect(sniffSpeechAudioMediaType(bytes([0x89], "PNG"))).toBeUndefined();
    expect(sniffSpeechAudioMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46]))).toBeUndefined();
  });
});
