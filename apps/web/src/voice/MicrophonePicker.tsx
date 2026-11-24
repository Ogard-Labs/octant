import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { RefreshCw } from "../ui/icons";
import {
  readMicrophonePreference,
  subscribeMicrophonePreference,
  writeMicrophonePreference,
} from "./microphonePreference";

const SYSTEM_DEFAULT = "system-default";
const MISSING = "missing";

interface AudioInput {
  readonly deviceId: string;
  readonly label: string;
}

/**
 * Lists this computer's microphones and remembers the one dictation records
 * from in this window. Chromium lists the default and communications
 * pseudo-devices beside the real ones; they are left out, because System
 * default already means the first and the second is a role, not a microphone.
 */
export function MicrophonePicker() {
  const preferred = useSyncExternalStore(
    subscribeMicrophonePreference,
    readMicrophonePreference,
    () => undefined,
  );
  const [inputs, setInputs] = useState<ReadonlyArray<AudioInput> | undefined>(undefined);
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.enumerateDevices === "function";

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(
        devices
          .filter(
            (device) =>
              device.kind === "audioinput" &&
              device.deviceId.length > 0 &&
              device.deviceId !== "default" &&
              device.deviceId !== "communications",
          )
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label.length > 0 ? device.label : `Microphone ${String(index + 1)}`,
          })),
      );
    } catch {
      setInputs([]);
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return undefined;
    void refresh();
    const onChange = () => void refresh();
    const media = navigator.mediaDevices;
    media.addEventListener?.("devicechange", onChange);
    return () => media.removeEventListener?.("devicechange", onChange);
  }, [refresh, supported]);

  if (!supported) {
    return (
      <p className="provider-settings__field-guidance">This browser cannot list microphones.</p>
    );
  }

  const missing =
    preferred !== undefined &&
    inputs !== undefined &&
    !inputs.some((input) => input.deviceId === preferred);
  const unnamed =
    inputs !== undefined && inputs.some((input) => input.label.startsWith("Microphone "));
  const options = [
    { id: SYSTEM_DEFAULT, label: "System default" },
    ...(inputs ?? []).map((input) => ({ id: input.deviceId, label: input.label })),
    ...(missing ? [{ id: MISSING, label: "Chosen microphone (not connected)" }] : []),
  ];
  const selected = preferred === undefined ? SYSTEM_DEFAULT : missing ? MISSING : preferred;

  return (
    <div className="voice-settings__choice">
      <div className="voice-settings__test-controls">
        <OctantSelectField
          aria-label="Microphone"
          className="settings-view__select window-no-drag"
          onValueChange={(value) => {
            if (value === MISSING) return;
            writeMicrophonePreference(value === SYSTEM_DEFAULT ? undefined : value);
          }}
          options={options}
          value={selected}
        />
        <OctantButton
          aria-label="Refresh microphones"
          onClick={() => void refresh()}
          size="icon"
          title="Refresh microphones"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </OctantButton>
      </div>
      {missing ? (
        <p className="provider-settings__field-guidance" role="status">
          That microphone isn't connected, so the system default records instead.
        </p>
      ) : unnamed ? (
        <p className="provider-settings__field-guidance">
          Names appear once you allow the microphone, for example with Test microphone.
        </p>
      ) : null}
    </div>
  );
}
