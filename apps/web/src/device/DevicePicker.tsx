import { useId, useRef, useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
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
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const chosen = choosable.find((device) => device.id === chosenId);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const at = choosable.findIndex((device) => device.id === chosenId);
    const next = choosable[(at + step + choosable.length) % choosable.length];
    if (next === undefined) return;
    setChosenId(next.id);
    rows.current[choosable.indexOf(next)]?.focus();
  };
  return (
    <section aria-labelledby={headingId} className="device-card">
      <h2 className="device-card__title" id={headingId}>
        {props.title}
      </h2>
      <p className="device-card__lede">
        Booting starts it in the background. Closing this tab leaves it running.
      </p>
      {choosable.length === 0 ? (
        <p className="device-card__lede">No device is available to start.</p>
      ) : (
        <div
          aria-labelledby={headingId}
          className="device-picks"
          onKeyDown={onKeyDown}
          role="radiogroup"
        >
          {choosable.map((device, index) => {
            const checked = device.id === chosenId;
            return (
              <OctantButton
                aria-checked={checked}
                className="device-pick"
                key={device.id}
                onClick={() => setChosenId(device.id)}
                ref={(element) => {
                  rows.current[index] = element;
                }}
                role="radio"
                tabIndex={checked ? 0 : -1}
                type="button"
                variant="bare"
              >
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
              </OctantButton>
            );
          })}
        </div>
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
