import {
  Activity,
  Camera,
  ChevronDown,
  ChevronLeft,
  Ellipsis,
  EyeOff,
  House,
  Keyboard,
  Lock,
  Power,
  Smartphone,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import type { DeviceChoice } from "./deviceModel";

export type DeviceDot = "running" | "busy" | "lost" | "idle";

/**
 * What the toolbar may offer. Only what the host can do today appears; a
 * control the host cannot perform is left out rather than shown disabled.
 */
export interface DeviceToolbarControls {
  /** Home, Lock, Back: the device's own buttons, sent through the input queue. */
  readonly hardware: boolean;
  readonly back: boolean;
  readonly screenshot: boolean;
  readonly typeText: boolean;
  readonly switchDevice: boolean;
  readonly stopLiveView: boolean;
  readonly shutdown: boolean;
}

export function DeviceToolbar(props: {
  readonly label: string;
  readonly title: string;
  readonly os?: string;
  readonly state: string;
  readonly dot: DeviceDot;
  readonly devices: ReadonlyArray<DeviceChoice>;
  readonly currentId?: string;
  readonly onSelectDevice?: (deviceId: string) => void;
  readonly controls: DeviceToolbarControls;
  /** A wide pane has room for Lock beside Home; a narrow one keeps it in More. */
  readonly wide: boolean;
  readonly viewOnly?: { readonly onShowApproval: () => void };
  readonly onKey: (key: "home" | "lock" | "back") => void;
  readonly onScreenshot: () => void;
  readonly onMenu: (item: DeviceMenuItem) => void;
}) {
  const { controls } = props;
  const menu = deviceMenuItems(props);
  return (
    <div
      aria-label={`${props.label} controls`}
      className="device-toolbar"
      onKeyDown={moveAlongToolbar}
      role="toolbar"
    >
      <DeviceSwitcher {...props} />
      <span className="device-toolbar__meta" aria-live="polite">
        {props.os === undefined ? null : <span className="device-toolbar__os">{props.os} · </span>}
        <span>{props.state}</span>
      </span>
      <span className="device-toolbar__spacer" />
      {props.viewOnly === undefined ? null : (
        <OctantButton
          className="device-chip"
          onClick={props.viewOnly.onShowApproval}
          title="Show the input approval again"
          type="button"
          variant="bare"
        >
          <EyeOff aria-hidden="true" size={12} />
          View only
        </OctantButton>
      )}
      {controls.back ? (
        <ToolbarButton
          disabled={!controls.hardware}
          icon={<ChevronLeft aria-hidden="true" size={16} />}
          label="Back"
          onClick={() => props.onKey("back")}
        />
      ) : null}
      <ToolbarButton
        disabled={!controls.hardware}
        icon={<House aria-hidden="true" size={16} />}
        label="Home"
        onClick={() => props.onKey("home")}
      />
      <ToolbarButton
        disabled={!controls.screenshot}
        icon={<Camera aria-hidden="true" size={16} />}
        label="Screenshot"
        onClick={props.onScreenshot}
        title="Screenshot (saved to evidence)"
      />
      {props.wide ? (
        <ToolbarButton
          disabled={!controls.hardware}
          icon={<Lock aria-hidden="true" size={16} />}
          label="Lock"
          onClick={() => props.onKey("lock")}
        />
      ) : null}
      {menu.length === 0 ? null : (
        <OctantMenu
          items={menu}
          onValueChange={(value) => {
            const item = menu.find((one) => one.value === value);
            if (item !== undefined) props.onMenu(item.value);
          }}
          selectionMode="action"
          trigger={<Ellipsis aria-hidden="true" size={16} />}
          triggerClassName="device-toolbar__more"
          triggerLabel="More"
          value=""
        />
      )}
    </div>
  );
}

export type DeviceMenuItem =
  | "type-text"
  | "lock"
  | "switch-device"
  | "diagnostics"
  | "stop-live-view"
  | "shutdown";

type DeviceMenuEntry = OctantMenuItem & { readonly value: DeviceMenuItem };

function deviceMenuItems(props: {
  readonly title: string;
  readonly wide: boolean;
  readonly controls: DeviceToolbarControls;
}): ReadonlyArray<DeviceMenuEntry> {
  const { controls } = props;
  const items: DeviceMenuEntry[] = [];
  if (controls.typeText) {
    items.push({ value: "type-text", label: "Type text…", icon: <Keyboard size={16} /> });
  }
  if (controls.hardware && !props.wide) {
    items.push({ value: "lock", label: "Lock", icon: <Lock size={16} /> });
  }
  if (controls.switchDevice) {
    items.push({ value: "switch-device", label: "Switch device…", icon: <Smartphone size={16} /> });
  }
  items.push({ value: "diagnostics", label: "Diagnostics", icon: <Activity size={16} /> });
  if (controls.stopLiveView) {
    items.push({ value: "stop-live-view", label: "Stop live view", icon: <EyeOff size={16} /> });
  }
  if (controls.shutdown) {
    items.push({ value: "shutdown", label: `Shut down ${props.title}`, icon: <Power size={16} /> });
  }
  return items;
}

function DeviceSwitcher(props: {
  readonly title: string;
  readonly dot: DeviceDot;
  readonly devices: ReadonlyArray<DeviceChoice>;
  readonly currentId?: string;
  readonly onSelectDevice?: (deviceId: string) => void;
}) {
  const name = (
    <>
      <span aria-hidden="true" className="device-dot" data-dot={props.dot} />
      <strong className="device-toolbar__name">{props.title}</strong>
    </>
  );
  const choices = props.devices.filter((device) => device.state !== "unavailable");
  if (props.onSelectDevice === undefined || choices.length < 2) {
    return <span className="device-toolbar__device">{name}</span>;
  }
  const onSelectDevice = props.onSelectDevice;
  return (
    <OctantMenu
      items={choices.map((device) => ({
        value: device.id,
        label: device.name,
        description: [device.os, deviceStateWord(device.state)].filter(Boolean).join(" · "),
      }))}
      onValueChange={onSelectDevice}
      trigger={
        <>
          {name}
          <ChevronDown aria-hidden="true" className="device-toolbar__chevron" size={12} />
        </>
      }
      triggerClassName="device-toolbar__device device-toolbar__device--switch"
      triggerLabel={`${props.title}, switch device`}
      value={props.currentId ?? ""}
    />
  );
}

function ToolbarButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly disabled: boolean;
  readonly title?: string;
}) {
  return (
    <OctantIconButton
      disabled={props.disabled}
      label={props.label}
      onClick={props.onClick}
      title={props.title ?? props.label}
      type="button"
    >
      {props.icon}
    </OctantIconButton>
  );
}

export function deviceStateWord(state: DeviceChoice["state"]): string {
  switch (state) {
    case "booted":
      return "Running";
    case "booting":
      return "Booting";
    case "shutting-down":
      return "Shutting down";
    case "shutdown":
      return "Shut down";
    case "unavailable":
      return "Unavailable";
  }
}

/**
 * Arrow keys move between the toolbar's controls, as a toolbar should; Tab
 * still leaves it. Disabled controls are skipped.
 */
function moveAlongToolbar(event: KeyboardEvent<HTMLDivElement>) {
  const forward = event.key === "ArrowRight";
  if (!forward && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
  const controls = [...event.currentTarget.querySelectorAll("button")].filter(
    (button) => !button.disabled,
  );
  const at = controls.findIndex((button) => button === document.activeElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (at + (forward ? 1 : -1) + controls.length) % controls.length;
  controls[next]?.focus();
}
