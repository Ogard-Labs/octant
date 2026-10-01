/** A serve-avd frame is a JPEG. An adb screencap frame is a PNG. */
export function androidFrameMediaType(bytes: Uint8Array): "image/jpeg" | "image/png" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/png";
}
