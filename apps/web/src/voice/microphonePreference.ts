/**
 * Which microphone dictation records from on this computer. It lives in this
 * app's browser storage, which every window of the app on this computer
 * shares, not in journaled settings: a browser device id is scoped to this
 * browser profile and means nothing on another computer or a paired device.
 * Absent means the system default.
 */
const KEY = "octant.voice-microphone.v1";
const CHANGED = "octant-voice-microphone";

export function readMicrophonePreference(): string | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return value === null || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

export function writeMicrophonePreference(deviceId: string | undefined): boolean {
  try {
    if (deviceId === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, deviceId);
    window.dispatchEvent(new Event(CHANGED));
    return true;
  } catch {
    return false;
  }
}

export function subscribeMicrophonePreference(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}
