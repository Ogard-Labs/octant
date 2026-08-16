import type { RemoteSessionBridge } from "@octant/client-runtime";
import {
  fetchRemoteOwnDeviceMetadata,
  isRemoteDeviceSelfServiceFailure,
  remoteRevokeSelf,
  remoteRotateDeviceKey,
  remoteSignOut,
} from "@octant/client-runtime";
import { AlertTriangle, CircleCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { useRemoteSession } from "./useRemoteSession";

export interface RemoteDeviceSelfPanelProps {
  readonly bridge: RemoteSessionBridge;
  readonly onSignedOut: () => void;
  readonly onRevoked: (warning?: string) => void;
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return "Unavailable";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "Unavailable";
  return new Date(parsed).toLocaleString();
}

const ROTATE_LABEL = "Rotate this device's key";

/**
 * Rotation ends the current session by design, so the panel says what the user
 * must do next instead of implying the connection survived.
 */
const ROTATE_SUCCESS =
  "Device key rotated. This session ended — reconnect this browser to continue with the new key.";

export function RemoteDeviceSelfPanel(props: RemoteDeviceSelfPanelProps) {
  const state = useRemoteSession(props.bridge);
  const alive = useRef(true);
  const focusReturnRef = useRef<HTMLButtonElement>(null);
  const rotateConfirmId = useId();
  const [metadata, setMetadata] =
    useState<Awaited<ReturnType<typeof fetchRemoteOwnDeviceMetadata>>>();
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [status, setStatus] = useState("");
  const [statusAssertive, setStatusAssertive] = useState(false);
  const ready = state.kind === "ready";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void fetchRemoteOwnDeviceMetadata({ bridge: props.bridge })
      .then((value) => {
        if (!alive.current) return;
        setMetadata(value);
      })
      .catch((error) => {
        if (!alive.current) return;
        setMetadata(undefined);
        if (isRemoteDeviceSelfServiceFailure(error)) {
          setStatusAssertive(true);
          setStatus(error.message);
        }
      });
  }, [props.bridge, ready, state.kind]);

  const runAction = async (
    label: string,
    action: () => Promise<unknown>,
    onComplete: (warning?: string) => void,
    successMessage?: string,
  ): Promise<void> => {
    setStatusAssertive(false);
    setStatus("");
    try {
      const result = await action();
      if (!alive.current) return;
      const warning = warningFrom(result);
      // A warning means the host action committed but local cleanup did not.
      // Reporting it as plain success would misstate this browser's state.
      setStatusAssertive(warning !== undefined);
      setStatus(warning ?? successMessage ?? `${label} completed.`);
      onComplete(warning);
    } catch (error) {
      if (!alive.current) return;
      setStatusAssertive(true);
      if (isRemoteDeviceSelfServiceFailure(error)) {
        setStatus(error.message);
      } else {
        setStatus(`${label} failed.`);
      }
      focusReturnRef.current?.focus();
    }
  };

  return (
    <section aria-label="This browser device" className="remote-shell__device-panel" role="region">
      <h2 className="remote-shell__section-title">This browser device</h2>
      <p className="remote-shell__device-copy">
        View metadata for this paired browser only. Remote browsers cannot manage other devices or
        host listener policy.
      </p>
      {metadata === undefined ? (
        <p className="remote-shell__device-muted">
          {ready
            ? "Loading device metadata…"
            : "Device metadata refreshes when the session is ready."}
        </p>
      ) : (
        <dl className="remote-shell__device-facts">
          <div className="remote-shell__device-fact">
            <dt>Label</dt>
            <dd>{metadata.deviceLabel}</dd>
          </div>
          <div className="remote-shell__device-fact">
            <dt>Last seen</dt>
            <dd>{formatTimestamp(metadata.lastSeenAt)}</dd>
          </div>
          <div className="remote-shell__device-fact">
            <dt>Device expires</dt>
            <dd>{formatTimestamp(metadata.expiresAt)}</dd>
          </div>
          <div className="remote-shell__device-fact">
            <dt>Session idle</dt>
            <dd>{formatTimestamp(metadata.sessionIdleExpiresAt)}</dd>
          </div>
        </dl>
      )}
      <div className="remote-shell__device-actions">
        <OctantButton
          disabled={!ready}
          onClick={() =>
            void runAction(
              "Sign out",
              () => remoteSignOut({ bridge: props.bridge }),
              props.onSignedOut,
            )
          }
          ref={focusReturnRef}
          type="button"
          variant="secondary"
        >
          Sign out
        </OctantButton>
        <OctantButton
          aria-controls={rotateConfirmId}
          aria-expanded={confirmingRotate}
          disabled={!ready}
          onClick={() => setConfirmingRotate(true)}
          type="button"
          variant="secondary"
        >
          {ROTATE_LABEL}
        </OctantButton>
        <OctantButton
          disabled={!ready}
          onClick={() =>
            void runAction(
              "Revoke this device",
              () => remoteRevokeSelf({ bridge: props.bridge }),
              props.onRevoked,
            )
          }
          type="button"
          variant="ghost"
        >
          Revoke this device
        </OctantButton>
      </div>
      {confirmingRotate && ready ? (
        <div
          aria-label="Confirm device key rotation"
          className="remote-shell__device-confirm"
          id={rotateConfirmId}
          role="group"
        >
          <p>
            Replace this browser&apos;s device key? The current key stops working immediately and
            cannot be restored. Use this if the current key may be compromised.
          </p>
          <p className="remote-shell__device-muted">
            Only this browser is affected. It stays paired, but this session ends and you must
            reconnect.
          </p>
          <div className="remote-shell__device-actions">
            <OctantButton
              onClick={() => {
                setConfirmingRotate(false);
                void runAction(
                  ROTATE_LABEL,
                  () => remoteRotateDeviceKey({ bridge: props.bridge }),
                  // The metadata on screen describes the superseded generation
                  // and no session remains to refresh it.
                  () => setMetadata(undefined),
                  ROTATE_SUCCESS,
                );
              }}
              type="button"
              variant="destructive"
            >
              Rotate key
            </OctantButton>
            <OctantButton onClick={() => setConfirmingRotate(false)} type="button" variant="ghost">
              Keep current key
            </OctantButton>
          </div>
        </div>
      ) : null}
      {status === "" ? null : (
        <p
          aria-live={statusAssertive ? "assertive" : "polite"}
          className="remote-shell__status"
          {...(statusAssertive ? { role: "alert" } : { role: "status" })}
        >
          {/* Status is carried by the words; the icon only speeds recognition,
              so colour is never the sole signal. */}
          {statusAssertive ? (
            <AlertTriangle aria-hidden="true" size={13} strokeWidth={1.8} />
          ) : (
            <CircleCheck aria-hidden="true" size={13} strokeWidth={1.8} />
          )}
          <span>{status}</span>
        </p>
      )}
    </section>
  );
}

/**
 * Revoke and rotate both report a non-fatal local-storage problem as `warning`
 * on an otherwise successful result, so one reader serves both.
 */
function warningFrom(result: unknown): string | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "warning" in result &&
    typeof result.warning === "string"
  ) {
    return result.warning;
  }
  return undefined;
}
