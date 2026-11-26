import { SPEECH_LOCAL_SAMPLE_RATE, SPEECH_LOCAL_WAV_HEADER_BYTES } from "@octant/contracts";

/**
 * The recording in the one shape the host's on-device engine takes. The
 * window's own decoder reads the browser's container, so no compressed audio
 * reaches native code, and the clip never touches a file.
 */
export async function toLocalClip(audio: Blob): Promise<Blob> {
  // An offline context decodes at its own rate, resampling as it goes.
  const context = new OfflineAudioContext(1, 1, SPEECH_LOCAL_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(await new Response(audio).arrayBuffer());
  const channels: Array<Float32Array> = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1)
    channels.push(decoded.getChannelData(channel));
  return encodeLocalClip(channels);
}

/** One channel's average of `channels`, as 16-bit PCM behind a 44-byte WAV header. */
export function encodeLocalClip(channels: ReadonlyArray<Float32Array>): Blob {
  const frames = channels[0]?.length ?? 0;
  const bytes = new DataView(new ArrayBuffer(SPEECH_LOCAL_WAV_HEADER_BYTES + frames * 2));
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      bytes.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  bytes.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVEfmt ");
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, SPEECH_LOCAL_SAMPLE_RATE, true);
  bytes.setUint32(28, SPEECH_LOCAL_SAMPLE_RATE * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  text(36, "data");
  bytes.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[frame] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / channels.length));
    bytes.setInt16(
      SPEECH_LOCAL_WAV_HEADER_BYTES + frame * 2,
      sample < 0 ? sample * 32_768 : sample * 32_767,
      true,
    );
  }
  return new Blob([bytes.buffer], { type: "audio/wav" });
}
