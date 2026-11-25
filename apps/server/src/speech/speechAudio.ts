import {
  SPEECH_LOCAL_SAMPLE_RATE,
  SPEECH_LOCAL_WAV_HEADER_BYTES,
  type SpeechAudioMediaType,
  type SpeechSynthesisFormat,
} from "@octant/contracts";

/**
 * Identify uploaded audio by its bytes, never by the declared type. A renderer
 * (or anything holding a window capability) chooses the multipart type; the
 * signature is what the provider will actually receive, so it is the fact the
 * host forwards. Unknown signatures are refused rather than passed through.
 */
export function sniffSpeechAudioMediaType(bytes: Uint8Array): SpeechAudioMediaType | undefined {
  if (bytes.byteLength < 12) return undefined;
  const signature = ascii(bytes, 0, 4);
  if ((signature === "RIFF" || signature === "RF64") && ascii(bytes, 8, 12) === "WAVE")
    return "audio/wav";
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

/**
 * Verify that synthesized audio bytes match the requested output format so a
 * provider returning an error page or a different container is never saved
 * under the requested extension.
 */
export function matchesSpeechSynthesisFormat(
  bytes: Uint8Array,
  format: SpeechSynthesisFormat,
): boolean {
  switch (format) {
    case "mp3":
      return sniffSpeechAudioMediaType(bytes) === "audio/mpeg";
    case "wav":
      return sniffSpeechAudioMediaType(bytes) === "audio/wav";
    case "opus":
      return isOggOpus(bytes);
  }
}

function isOggOpus(bytes: Uint8Array): boolean {
  // RFC 3533 + RFC 7845: first Ogg page starts with "OggS", byte 26 holds
  // segment count, and the first page payload starts with "OpusHead".
  if (bytes.byteLength < 36 || ascii(bytes, 0, 4) !== "OggS") return false;
  const segmentCount = bytes[26] ?? 0;
  const payloadOffset = 27 + segmentCount;
  return (
    payloadOffset + 8 <= bytes.byteLength &&
    ascii(bytes, payloadOffset, payloadOffset + 8) === "OpusHead"
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index] ?? 0);
  return out;
}

/**
 * The PCM of a clip in the one shape the on-device engine takes, or
 * `undefined`. Every header field is checked against that shape, so nothing
 * here follows a length or an offset the sender chose.
 */
export function readLocalSpeechPcm(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength <= SPEECH_LOCAL_WAV_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const audioBytes = bytes.byteLength - SPEECH_LOCAL_WAV_HEADER_BYTES;
  const expected =
    ascii(bytes, 0, 4) === "RIFF" &&
    view.getUint32(4, true) === bytes.byteLength - 8 &&
    ascii(bytes, 8, 16) === "WAVEfmt " &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === SPEECH_LOCAL_SAMPLE_RATE &&
    view.getUint32(28, true) === SPEECH_LOCAL_SAMPLE_RATE * 2 &&
    view.getUint16(32, true) === 2 &&
    view.getUint16(34, true) === 16 &&
    ascii(bytes, 36, 40) === "data" &&
    view.getUint32(40, true) === audioBytes &&
    audioBytes % 2 === 0;
  return expected ? bytes.subarray(SPEECH_LOCAL_WAV_HEADER_BYTES) : undefined;
}
