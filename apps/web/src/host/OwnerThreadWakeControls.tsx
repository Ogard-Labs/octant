import { useRef, useState } from "react";
import type { OwnerThreadWake, OwnerThreadWakeSwitch } from "@octant/contracts";
import {
  OWNER_THREAD_WAKE_LABELS,
  changeOwnerThreadWake,
  ownerThreadWakeNotice,
  readOwnerThreadWake,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * One Code thread's wake switches, read and changed through the owner routes
 * (docs/design/coordinator-threads.md#talking-to-workers). Each change asks for
 * its own fresh unlock and is sent against the reading shown; after any answer
 * the reading is dropped, so a spent or uncertain change never leaves a button
 * over state the host may no longer hold. The coordinator role is not here.
 * The caller remounts this per host client and thread.
 */
export function OwnerThreadWakeControls(props: {
  readonly client: OwnerSpoke["client"];
  readonly threadId: string;
}) {
  const [wake, setWake] = useState<OwnerThreadWake>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const read = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setWake(undefined);
    setMessage("");
    const result = await readOwnerThreadWake(props.client, props.threadId);
    if (result.status === "read") setWake(result.wake);
    else setMessage(result.message);
    inFlight.current = false;
    setBusy(false);
  };
  const change = async (wakeSwitch: OwnerThreadWakeSwitch, next: boolean) => {
    if (wake === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await changeOwnerThreadWake(props.client, wake, wakeSwitch, next);
    setWake(undefined);
    setMessage(
      ownerThreadWakeNotice(
        result,
        `${OWNER_THREAD_WAKE_LABELS[wakeSwitch]} is ${next ? "on" : "off"}. Read the switches again to see the current state.`,
      ).message,
    );
    inFlight.current = false;
    setBusy(false);
  };
  const row = (wakeSwitch: OwnerThreadWakeSwitch, on: boolean) => (
    <div className="settings-section-line" key={wakeSwitch}>
      <span>
        {OWNER_THREAD_WAKE_LABELS[wakeSwitch]}: {on ? "On" : "Off"}
      </span>{" "}
      <OctantButton
        type="button"
        variant="secondary"
        size="xs"
        disabled={busy}
        onClick={() => void change(wakeSwitch, !on)}
      >
        {on ? "Turn off" : "Turn on"} {OWNER_THREAD_WAKE_LABELS[wakeSwitch]}
      </OctantButton>
    </div>
  );
  return (
    <div aria-label="Wake switches" role="group">
      <p className="settings-section-line">
        Wake switches let other threads start turns on this one while nobody is watching. Each
        change asks for its own fresh unlock.
      </p>
      <OctantButton type="button" variant="secondary" disabled={busy} onClick={() => void read()}>
        Read wake switches
      </OctantButton>
      {wake === undefined ? null : (
        <>
          {row("message-wake", wake.messageWake)}
          {wake.coordinatorWake === undefined
            ? null
            : row("coordinator-wake", wake.coordinatorWake)}
        </>
      )}
      {message === "" ? null : (
        <p className="settings-section-line" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
