import type { SpeechAudioMediaType } from "@octant/contracts";

/**
 * Identify uploaded audio by its bytes, never by the declared type. A renderer
 * (or anything holding a window capability) chooses the multipart type; the
 * signature is what the provider will actually receive, so it is the fact the
 * host forwards. Unknown signatures are refused rather than passed through.
 */
export function sniffSpeechAudioMediaType(bytes: Uint8Array): SpeechAudioMediaType | undefined {
  if (bytes.byteLength < 12) return undefined;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm";
  }
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 4, 8) === "ftyp") return "audio/mp4";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  // A raw MPEG frame header: sync word 0xFFE or 0xFFF.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index] ?? 0);
  return out;
}
