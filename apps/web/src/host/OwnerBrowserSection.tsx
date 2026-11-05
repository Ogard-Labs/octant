import type { OwnerBrowserClient, OwnerBrowserClientResult } from "@octant/client-runtime";
import type {
  OwnerBrowserControl,
  OwnerBrowserFrame,
  OwnerBrowserInput,
  OwnerBrowserRequest,
  OwnerBrowserTargetDescriptor,
} from "@octant/contracts/owner-browser";
import { useEffect, useRef, useState } from "react";
import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";

export interface OwnerBrowserSectionProps {
  readonly client: OwnerBrowserClient;
  readonly hostName: string;
}

export function OwnerBrowserSection({ client, hostName }: OwnerBrowserSectionProps) {
  const [targets, setTargets] = useState<ReadonlyArray<typeof OwnerBrowserTargetDescriptor.Type>>(
    [],
  );
  const [control, setControl] = useState<OwnerBrowserControl>();
  const [frame, setFrame] = useState<OwnerBrowserFrame>();
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const currentControl = useRef<OwnerBrowserControl | undefined>(undefined);
  const lifetime = useRef<{
    client: OwnerBrowserClient;
    epoch: number;
    abort: AbortController;
    busy: boolean;
    control: OwnerBrowserControl | undefined;
  }>({ client, epoch: 0, abort: new AbortController(), busy: false, control: undefined });
  // Ref updates during render also fence a response before the effect cleanup runs.
  if (lifetime.current.client !== client) {
    lifetime.current.abort.abort();
    lifetime.current = {
      client,
      epoch: lifetime.current.epoch + 1,
      abort: new AbortController(),
      busy: false,
      control: undefined,
    };
    currentControl.current = undefined;
  }
  useEffect(() => {
    setTargets([]);
    setControl(undefined);
    setFrame(undefined);
    setText("");
    setNotice(undefined);
    setBusy(false);
    const scope = lifetime.current;
    const stop = () => {
      const held = scope.control;
      scope.control = undefined;
      if (held !== undefined)
        void scope.client
          .browser(
            { kind: "stop", controlId: held.id, sequence: held.nextSequence },
            AbortSignal.timeout(3_000),
          )
          .catch(() => undefined);
    };
    const hide = () => {
      if (document.visibilityState !== "hidden") return;
      scope.abort.abort();
      scope.epoch += 1;
      scope.busy = false;
      stop();
      currentControl.current = undefined;
      setControl(undefined);
      setFrame(undefined);
      setText("");
      setBusy(false);
      setNotice(
        "Remote control is stopping. If the host is unreachable, its lease expires within 60 seconds. The page remains held for a person on the host Mac.",
      );
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      scope.abort.abort();
      scope.epoch += 1;
      stop();
      document.removeEventListener("visibilitychange", hide);
    };
  }, [client]);

  useEffect(() => {
    if (control === undefined) return;
    const timer = setTimeout(
      () => {
        currentControl.current = undefined;
        setControl(undefined);
        setFrame(undefined);
        setText("");
        lifetime.current.abort.abort();
        lifetime.current.epoch += 1;
        lifetime.current.busy = false;
        setBusy(false);
        setNotice(
          "The 60-second control expired. The page remains held; unlock again or finish on the host Mac.",
        );
      },
      Math.max(0, Math.min(60_000, Date.parse(control.expiresAt) - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [control?.id, control?.expiresAt]);

  const clearControl = () => {
    currentControl.current = undefined;
    lifetime.current.control = undefined;
    setControl(undefined);
    setFrame(undefined);
    setText("");
  };
  const send = async (command: OwnerBrowserRequest) => {
    const scope = lifetime.current;
    if (scope.busy) return;
    if (scope.abort.signal.aborted) scope.abort = new AbortController();
    scope.busy = true;
    setBusy(true);
    setNotice(undefined);
    const epoch = scope.epoch;
    const current = () =>
      lifetime.current === scope &&
      scope.client === client &&
      scope.epoch === epoch &&
      !scope.abort.signal.aborted;
    const accept = (result: OwnerBrowserClientResult) => {
      if (!current()) return;
      if (result.status === "targets") {
        setTargets(result.targets);
        return;
      }
      if (result.status === "controlled" || result.status === "frame") {
        currentControl.current = result.control;
        scope.control = result.control;
        setControl(result.control);
        if (result.status === "frame") setFrame(result.frame);
        return;
      }
      if (result.status === "input" && result.effect !== "possible") {
        const held = currentControl.current;
        if (held !== undefined) {
          const next = { ...held, nextSequence: result.nextSequence };
          currentControl.current = next;
          scope.control = next;
          setControl(next);
        }
        setFrame(undefined);
        return;
      }
      clearControl();
      setNotice(
        result.status === "released"
          ? command.kind === "stop"
            ? "Remote control stopped. The page remains held for a person on the host Mac."
            : "Handed back. The agent must read the page again before acting."
          : result.status === "not-unlocked"
            ? "The unlock was cancelled or unavailable. No remote control was granted."
            : result.status === "input"
              ? "The input may have taken effect. It was not retried. Finish on the host Mac."
              : result.status === "refused"
                ? `Control refused (${result.reason}). The page remains held if takeover had begun. Finish on the host Mac or unlock again.`
                : "The host is unreachable. An input already sent may have taken effect. The page remains held; no input was retried.",
      );
    };
    try {
      const result = await client.browser(command, scope.abort.signal);
      accept(result);
      const held = currentControl.current;
      if (
        current() &&
        held !== undefined &&
        (result.status === "controlled" ||
          (result.status === "input" && result.effect !== "possible"))
      ) {
        accept(
          await client.browser(
            { kind: "frame", controlId: held.id, sequence: held.nextSequence },
            scope.abort.signal,
          ),
        );
      }
    } catch {
      if (current()) {
        clearControl();
        setNotice(
          "Connection lost. An input already sent may have taken effect; it was not retried. Finish on the host Mac.",
        );
      }
    } finally {
      if (current()) {
        scope.busy = false;
        setBusy(false);
      }
    }
  };
  const input = (value: OwnerBrowserInput) => {
    const held = currentControl.current;
    if (held === undefined || frame === undefined) return;
    void send({
      kind: "input",
      controlId: held.id,
      sequence: held.nextSequence,
      expectedFrame: frame.sequence,
      input: value,
    });
  };
  const stopControl = () => {
    const held = currentControl.current;
    if (held === undefined) return;
    const scope = lifetime.current;
    scope.abort.abort();
    scope.epoch += 1;
    scope.busy = false;
    setFrame(undefined);
    setText("");
    void send({ kind: "stop", controlId: held.id, sequence: held.nextSequence });
  };

  return (
    <SettingsSection title={`Owner Browser · ${hostName}`}>
      <p className="settings-section-line">
        Control an already-open Code Private page for up to 60 seconds with a fresh owner unlock.
        The agent stays held until you explicitly hand back or reclaim on the host Mac.
      </p>
      <p className="settings-section-line">
        Frames can show passwords and account content. They are sent only to this owner view and are
        not saved as screenshots or agent observations. Device-local prompts, popups and unsupported
        pages must be completed on the host Mac.
      </p>
      {notice === undefined ? null : <SettingsState kind="empty">{notice}</SettingsState>}
      <OctantButton
        disabled={busy || control !== undefined}
        onClick={() => void send({ kind: "targets" })}
        size="sm"
        variant="secondary"
      >
        List open pages
      </OctantButton>
      {control !== undefined ? (
        <>
          <p className="settings-section-line">
            {targets.find((entry) => entry.target.contextId === control.target.contextId)
              ?.threadTitle ?? "Code thread"}{" "}
            · {control.target.threadId}
          </p>
          <p className="settings-section-line">
            {control.target.origin} · Private · controlled by {control.controllerName} · expires{" "}
            {new Date(control.expiresAt).toLocaleTimeString()}
          </p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <OctantButton
              disabled={busy}
              onClick={() =>
                void send({ kind: "frame", controlId: control.id, sequence: control.nextSequence })
              }
              size="sm"
              variant="secondary"
            >
              Refresh frame
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() =>
                void send({
                  kind: "hand-back",
                  controlId: control.id,
                  sequence: control.nextSequence,
                })
              }
              size="sm"
            >
              Hand back to the agent
            </OctantButton>
            <OctantButton onClick={stopControl} size="sm" variant="secondary">
              Stop remote control
            </OctantButton>
          </div>
          {frame === undefined ? (
            <SettingsState kind="empty">No current frame. Refresh before input.</SettingsState>
          ) : (
            <OctantButton
              variant="bare"
              aria-label="Page view. Tap a point, or press Enter for the focused page control."
              disabled={busy}
              style={{
                display: "block",
                width: "100%",
                height: "auto",
                padding: 0,
                overflow: "hidden",
                cursor: "crosshair",
              }}
              type="button"
              onClick={(event) => {
                if (event.detail === 0) {
                  input({ kind: "press", key: "Enter" });
                  return;
                }
                const bounds = event.currentTarget.querySelector("img")?.getBoundingClientRect();
                if (bounds !== undefined && bounds.width > 0 && bounds.height > 0)
                  input({
                    kind: "tap",
                    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
                    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
                  });
              }}
            >
              <img
                alt="Current person-only Browser frame"
                draggable={false}
                src={frame.dataUrl}
                style={{ display: "block", width: "100%", height: "auto" }}
              />
            </OctantButton>
          )}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const value = text;
              setText("");
              if (value.length > 0) input({ kind: "type", text: value });
            }}
          >
            <OctantField>
              <OctantFieldLabel htmlFor={`owner-type-${control.id}`}>
                Text to type into the page
              </OctantFieldLabel>
              <OctantInput
                autoComplete="off"
                disabled={busy || frame === undefined}
                id={`owner-type-${control.id}`}
                maxLength={4096}
                onChange={(event) => setText(event.target.value)}
                spellCheck={false}
                type="password"
                value={text}
              />
            </OctantField>
            <OctantButton
              disabled={busy || frame === undefined || text.length === 0}
              size="sm"
              type="submit"
              variant="secondary"
            >
              Type text
            </OctantButton>
          </form>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {(
              [
                "Tab",
                "Enter",
                "Backspace",
                "Escape",
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
              ] as const
            ).map((key) => (
              <OctantButton
                disabled={busy || frame === undefined}
                key={key}
                onClick={() => input({ kind: "press", key })}
                size="sm"
                variant="secondary"
              >
                {key}
              </OctantButton>
            ))}
            <OctantButton
              disabled={busy || frame === undefined}
              onClick={() => input({ kind: "scroll", x: 0.5, y: 0.5, deltaX: 0, deltaY: -500 })}
              size="sm"
              variant="secondary"
            >
              Scroll up
            </OctantButton>
            <OctantButton
              disabled={busy || frame === undefined}
              onClick={() => input({ kind: "scroll", x: 0.5, y: 0.5, deltaX: 0, deltaY: 500 })}
              size="sm"
              variant="secondary"
            >
              Scroll down
            </OctantButton>
          </div>
        </>
      ) : (
        <ul className="setgroup" aria-label="Eligible open Browser pages">
          {targets.map((entry) => (
            <li className="setrow" key={entry.target.contextId}>
              <span className="setrow-label">
                {entry.threadTitle} · {entry.target.origin} · Private
              </span>
              <div className="setrow-control">
                <OctantButton
                  aria-label={`Unlock and take over ${entry.threadTitle}`}
                  disabled={busy}
                  onClick={() => void send({ kind: "take-over", target: entry.target })}
                  size="sm"
                  variant="secondary"
                >
                  Unlock and take over
                </OctantButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
