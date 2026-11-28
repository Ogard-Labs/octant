import { useId, useState } from "react";
import { InfoTip, PaneBar } from "../shell/PaneBar";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantRadioGroup, OctantRadioGroupItem } from "../ui/base/OctantRadioGroup";
import type { DeviceChoice } from "./deviceModel";
import { deviceStateWord } from "./DeviceToolbar";

/**
 * Choose a device and start it. A running one is shown instead of booted
 * again; one the host reports unavailable cannot be chosen.
 */
export function DevicePicker(props: {
  readonly title: string;
  readonly devices: ReadonlyArray<DeviceChoice>;
  readonly currentId?: string;
  readonly busy: boolean;
  readonly onBoot?: (deviceId: string) => void;
  readonly onShow?: (deviceId: string) => void;
  readonly onCancel?: () => void;
}) {
  const headingId = useId();
  const choosable = props.devices.filter((device) => device.state !== "unavailable");
  const [chosenId, setChosenId] = useState(
    () =>
      choosable.find((device) => device.id === props.currentId)?.id ??
      choosable.find((device) => device.state === "booted")?.id ??
      choosable[0]?.id,
  );
  const chosen = choosable.find((device) => device.id === chosenId);
  return (
    <section aria-labelledby={headingId} className="device-card">
      <PaneBar title={<span id={headingId}>{props.title}</span>}>
        <InfoTip text="Booting starts it in the background. Closing this tab leaves it running." />
      </PaneBar>
      {choosable.length === 0 ? (
        <p className="device-card__lede">No device is available to start.</p>
      ) : (
        <OctantRadioGroup
          aria-labelledby={headingId}
          className="device-picks"
          onValueChange={setChosenId}
          value={chosenId ?? ""}
        >
          {choosable.map((device) => (
            <OctantRadioGroupItem className="device-pick" key={device.id} value={device.id}>
              <span aria-hidden="true" className="device-pick__radio" />
              <span className="device-pick__name">{device.name}</span>
              <span className="device-pick__meta">
                {[
                  device.os,
                  device.state === "shutdown" ? undefined : deviceStateWord(device.state),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </OctantRadioGroupItem>
          ))}
        </OctantRadioGroup>
      )}
      <div className="device-card__actions">
        {props.onCancel === undefined ? null : (
          <OctantButton onClick={props.onCancel} type="button" variant="ghost">
            Cancel
          </OctantButton>
        )}
        {chosen === undefined ? null : chosen.state === "booted" ? (
          props.onShow === undefined ? null : (
            <OctantButton onClick={() => props.onShow?.(chosen.id)} type="button">
              Show {chosen.name}
            </OctantButton>
          )
        ) : props.onBoot === undefined ? null : (
          <OctantButton
            disabled={props.busy || chosen.state !== "shutdown"}
            onClick={() => props.onBoot?.(chosen.id)}
            type="button"
          >
            Boot {chosen.name}
          </OctantButton>
        )}
      </div>
    </section>
  );
}
