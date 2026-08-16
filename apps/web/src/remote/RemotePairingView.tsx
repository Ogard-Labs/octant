import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  createDefaultDeviceKeyStore,
  createRemotePairingClient,
  createRemoteSessionBridge,
} from "@octant/client-runtime";
import type { RemotePairingClient, RemoteSessionBridge } from "@octant/client-runtime";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ShellState } from "../shell/ShellState";
import { useRemotePairing } from "./useRemotePairing";
import { RemoteShellView } from "./RemoteShellView";

type RemotePairingTicket = { readonly ticketId: string; readonly ticketProof: string };

export interface RemotePairingViewProps {
  readonly baseUrl: string;
  readonly ticket?: RemotePairingTicket | undefined;
  readonly client?: RemotePairingClient;
  readonly sessionClient?: RemoteSessionBridge;
  readonly replaceFragment?: (href: string) => void;
}

export function RemotePairingView(props: RemotePairingViewProps) {
  const deviceKeyStore = useMemo(() => createDefaultDeviceKeyStore(), []);
  const client = useMemo(
    () =>
      props.client ??
      createRemotePairingClient({
        baseUrl: props.baseUrl,
        fetch: globalThis.fetch,
        webBuildVersion: "0.1.0",
        deviceKeyStore,
      }),
    [props.baseUrl, props.client, deviceKeyStore],
  );
  const sessionClient = useMemo(
    () =>
      props.sessionClient ??
      createRemoteSessionBridge({
        fetch: globalThis.fetch,
        deviceKeyStore,
      }),
    [props.sessionClient, deviceKeyStore],
  );
  const pairing = useRemotePairing({
    baseUrl: props.baseUrl,
    ticket: props.ticket,
    client,
    sessionClient,
    replaceFragment: props.replaceFragment,
  });
  const [resetWarning, setResetWarning] = useState<string>();
  const resetFromShell = useCallback(
    (warning?: string) => {
      setResetWarning(warning);
      pairing.reset();
    },
    [pairing.reset],
  );

  switch (pairing.screen.kind) {
    case "entry":
      return (
        <RemotePairingEntry
          typedCode={pairing.typedCode}
          setTypedCode={(value) => {
            setResetWarning(undefined);
            pairing.setTypedCode(value);
          }}
          submitTypedCode={() => {
            setResetWarning(undefined);
            pairing.submitTypedCode();
          }}
          inputError={pairing.screen.inputError}
          warning={resetWarning}
        />
      );
    case "requesting-hello":
      return (
        <RemotePairingShellState
          state="loading"
          title="Contacting Octant host..."
          message="Fetching the host identity and pairing policy."
        />
      );
    case "confirm":
      return (
        <RemotePairingConfirm
          hostHello={pairing.screen.hostHello}
          onPair={pairing.confirmPairing}
        />
      );
    case "claiming":
      return (
        <RemotePairingShellState
          state="loading"
          title="Sending pairing request..."
          message="The host will be asked to approve this browser."
        />
      );
    case "resuming":
      return (
        <RemotePairingShellState
          state="loading"
          title="Resuming remote session..."
          message="Checking this browser's paired device without exposing its key material."
        />
      );
    case "resumed":
      return <RemoteShellView bridge={sessionClient} onReset={resetFromShell} />;
    case "waiting":
      return <RemotePairingWaiting claim={pairing.screen.claim} onCancel={pairing.reset} />;
    case "approved":
      return <RemoteShellView bridge={sessionClient} onReset={resetFromShell} />;
    case "failed":
      return (
        <RemotePairingFailed
          category={pairing.screen.category}
          message={pairing.screen.message}
          onRetry={pairing.retry}
          onReset={pairing.reset}
        />
      );
  }
}

interface RemotePairingEntryProps {
  readonly typedCode: string;
  readonly setTypedCode: (value: string) => void;
  readonly submitTypedCode: () => void;
  readonly inputError?: string | undefined;
  readonly warning?: string | undefined;
}

function RemotePairingEntry(props: RemotePairingEntryProps) {
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [submitted, setSubmitted] = useState(false);

  return (
    <section aria-label="Remote browser pairing" className="remote-pairing" role="region">
      <h1 className="remote-pairing__title">Pair this browser with Octant</h1>
      <p className="remote-pairing__description">
        Paste a pairing link from the host, or type a pairing code.
      </p>
      {props.warning === undefined ? null : (
        <p aria-live="assertive" className="remote-shell__status" role="alert">
          {props.warning}
        </p>
      )}
      <form
        ref={formRef}
        className="remote-pairing__form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          props.submitTypedCode();
        }}
      >
        <label className="remote-pairing__label" htmlFor={inputId}>
          Pairing link or code
        </label>
        <OctantInput
          aria-describedby={props.inputError ? `${inputId}-error` : undefined}
          aria-invalid={
            props.inputError !== undefined || (submitted && props.typedCode.trim().length === 0)
          }
          autoFocus
          className="remote-pairing__input"
          id={inputId}
          onChange={(event) => props.setTypedCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              formRef.current?.requestSubmit();
            }
          }}
          placeholder="https://mac.example.test/#ticketId=...&ticketProof=..."
          type="text"
          value={props.typedCode}
        />
        {props.inputError === undefined ? null : (
          <span className="remote-pairing__error" id={`${inputId}-error`} role="alert">
            {props.inputError}
          </span>
        )}
        <OctantButton className="remote-pairing__button" type="submit" variant="default">
          Continue
        </OctantButton>
      </form>
    </section>
  );
}

interface RemotePairingConfirmProps {
  readonly hostHello: {
    readonly displayName: string;
    readonly hostId: string;
    readonly hostKeyFingerprint: string;
    readonly remoteOrigin: string;
  };
  readonly onPair: (deviceLabel: string) => void;
}

function RemotePairingConfirm(props: RemotePairingConfirmProps) {
  const inputId = useId();
  const [deviceLabel, setDeviceLabel] = useState("Remote browser");

  return (
    <section aria-label="Confirm host identity" className="remote-pairing" role="region">
      <h1 className="remote-pairing__title">Confirm this host</h1>
      <div className="remote-pairing__identity">
        <RemotePairingFact label="Host" value={props.hostHello.displayName} />
        <RemotePairingFact label="Host ID" value={props.hostHello.hostId} />
        <RemotePairingFact
          label="Host key fingerprint"
          value={props.hostHello.hostKeyFingerprint}
          isMonospace
        />
        <RemotePairingFact label="Origin" value={props.hostHello.remoteOrigin} />
      </div>
      <form
        className="remote-pairing__form"
        onSubmit={(event) => {
          event.preventDefault();
          props.onPair(deviceLabel.trim() || "Remote browser");
        }}
      >
        <label className="remote-pairing__label" htmlFor={inputId}>
          Device label
        </label>
        <OctantInput
          className="remote-pairing__input"
          id={inputId}
          onChange={(event) => setDeviceLabel(event.target.value)}
          value={deviceLabel}
        />
        <OctantButton className="remote-pairing__button" type="submit" variant="default">
          Pair this browser
        </OctantButton>
      </form>
    </section>
  );
}

interface RemotePairingWaitingProps {
  readonly claim: {
    readonly comparisonCode: string;
    readonly deviceKeyFingerprint: string;
    readonly hostDisplayName: string;
    readonly hostKeyFingerprint: string;
  };
  readonly onCancel: () => void;
}

function RemotePairingWaiting(props: RemotePairingWaitingProps) {
  return (
    <section
      aria-label="Waiting for host approval"
      aria-live="polite"
      className="remote-pairing"
      role="status"
    >
      <h1 className="remote-pairing__title">Waiting for host approval</h1>
      <p className="remote-pairing__description">
        Compare the code below with the one shown on the host. Approve on the host, not here.
      </p>
      <div className="remote-pairing__comparison" role="status">
        <span className="remote-pairing__comparison-label">Comparison code</span>
        <span className="remote-pairing__comparison-code" translate="no">
          {props.claim.comparisonCode}
        </span>
      </div>
      <div className="remote-pairing__identity">
        <RemotePairingFact label="Host" value={props.claim.hostDisplayName} />
        <RemotePairingFact
          label="Host key fingerprint"
          value={props.claim.hostKeyFingerprint}
          isMonospace
        />
        <RemotePairingFact
          label="Your key fingerprint"
          value={props.claim.deviceKeyFingerprint}
          isMonospace
        />
      </div>
      <OctantButton
        className="remote-pairing__button"
        onClick={props.onCancel}
        type="button"
        variant="secondary"
      >
        Cancel
      </OctantButton>
    </section>
  );
}

type FailedCategory =
  | "denied"
  | "expired"
  | "revoked"
  | "lost-key"
  | "host-changed"
  | "incompatible"
  | "invalid"
  | "rate-limited"
  | "recovery-required"
  | "unavailable";

interface RemotePairingFailedProps {
  readonly category: FailedCategory;
  readonly message: string;
  readonly onRetry: () => void;
  readonly onReset: () => void;
}

function RemotePairingFailed(props: RemotePairingFailedProps) {
  const canRetry = props.category === "unavailable" || props.category === "rate-limited";
  return (
    <ShellState
      action={
        canRetry
          ? { label: "Try again", onClick: props.onRetry }
          : { label: "Start over", onClick: props.onReset }
      }
      message={props.message}
      role="alert"
      state={
        props.category === "rate-limited" || props.category === "invalid"
          ? "warning"
          : "disconnected"
      }
      title={
        props.category === "denied"
          ? "Pairing denied"
          : props.category === "expired"
            ? "Device credential expired"
            : props.category === "revoked"
              ? "Device revoked"
              : props.category === "lost-key"
                ? "Device key unavailable"
                : props.category === "host-changed"
                  ? "Host identity changed"
                  : props.category === "incompatible"
                    ? "Host incompatible"
                    : props.category === "recovery-required"
                      ? "Remote access requires re-pairing"
                      : "Pairing failed"
      }
    />
  );
}

function RemotePairingShellState(props: {
  readonly state: "loading" | "disconnected" | "warning" | "neutral";
  readonly title: string;
  readonly message: string;
}) {
  return (
    <div className="remote-pairing__centered">
      <ShellState message={props.message} state={props.state} title={props.title} />
    </div>
  );
}

interface RemotePairingFactProps {
  readonly label: string;
  readonly value: string;
  readonly isMonospace?: boolean;
}

function RemotePairingFact(props: RemotePairingFactProps) {
  return (
    <div className="remote-pairing__fact">
      <span className="remote-pairing__fact-label">{props.label}</span>
      <span
        className={`remote-pairing__fact-value${
          props.isMonospace ? " remote-pairing__fact-value--monospace" : ""
        }`}
        title={props.value}
      >
        {props.value}
      </span>
    </div>
  );
}
