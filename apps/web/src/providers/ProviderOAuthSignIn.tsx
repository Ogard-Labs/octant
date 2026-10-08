import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export type ProviderOAuthSignInState =
  | { readonly kind: "signed-out"; readonly notice?: string }
  | { readonly kind: "awaiting-consent"; readonly detail: string; readonly href?: string }
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  /** Sign-out could not reach the issuer; the sign-in is still active. */
  | { readonly kind: "not-revoked"; readonly accountLabel: string }
  | { readonly kind: "expired" }
  | { readonly kind: "refused"; readonly message: string };

export interface ProviderOAuthSignInProps {
  readonly accountLabel: string;
  readonly termsSummary: string;
  readonly termsRequired: boolean;
  readonly state: ProviderOAuthSignInState;
  readonly disabled?: boolean;
  readonly onAcknowledge: () => void;
  readonly onSignIn: () => void;
  /** Absent where the endpoint takes no key, such as one a sign-in created. */
  readonly onUseApiKey?: () => void;
  readonly onSignOut: () => void;
  readonly onSignOutLocally: () => void;
}

/**
 * Sign-in beside the API-key path. The component renders only the public
 * state it is given: no token, code verifier, or credential reference.
 */
export function ProviderOAuthSignIn(props: ProviderOAuthSignInProps) {
  const disabled = props.disabled === true;
  const showTerms = props.termsRequired && props.state.kind === "signed-out";
  return (
    <div className="provider-card__edit-actions">
      {props.state.kind === "signed-in" ? (
        <p>
          Signed in as <span className="oct-meta--mono">{props.state.accountLabel}</span>
        </p>
      ) : null}
      {props.state.kind === "signed-out" && props.state.notice !== undefined ? (
        <p role="status">{props.state.notice}</p>
      ) : null}
      {props.state.kind === "not-revoked" ? (
        <p role="status">
          Couldn't reach the sign-in service to end the sign-in for{" "}
          <span className="oct-meta--mono">{props.state.accountLabel}</span>, so it is still active.
          Try again, or sign out on this computer only.
        </p>
      ) : null}
      {props.state.kind === "expired" ? <p>Sign in again to use this provider.</p> : null}
      {props.state.kind === "refused" ? <p>{props.state.message}</p> : null}
      {props.state.kind === "awaiting-consent" ? (
        <p aria-live="polite">
          {props.state.detail}
          {props.state.href === undefined ? null : (
            <>
              {" "}
              <a href={props.state.href} rel="noreferrer">
                Open the sign-in page
              </a>
            </>
          )}
        </p>
      ) : null}
      {showTerms ? (
        <div>
          <p>{props.termsSummary}</p>
          <OctantButton disabled={disabled} onClick={props.onAcknowledge} size="sm" type="button">
            Acknowledge and continue
          </OctantButton>
        </div>
      ) : null}
      <OctantButton
        disabled={disabled || showTerms}
        onClick={props.onSignIn}
        size="sm"
        type="button"
      >
        Sign in
      </OctantButton>
      {props.onUseApiKey === undefined ? null : (
        <OctantButton
          disabled={disabled}
          onClick={props.onUseApiKey}
          size="sm"
          type="button"
          variant="outline"
        >
          Use an API key
        </OctantButton>
      )}
      {props.state.kind === "signed-in" || props.state.kind === "not-revoked" ? (
        <OctantButton
          disabled={disabled}
          onClick={props.onSignOut}
          size="sm"
          type="button"
          variant="destructive"
        >
          Sign out
        </OctantButton>
      ) : null}
      {props.state.kind === "not-revoked" ? (
        <OctantButton
          disabled={disabled}
          onClick={props.onSignOutLocally}
          size="sm"
          type="button"
          variant="outline"
        >
          Sign out on this computer only
        </OctantButton>
      ) : null}
    </div>
  );
}

export interface ProviderOAuthCommand {
  readonly kind: "status" | "acknowledge" | "begin" | "poll" | "sign-out" | "sign-out-locally";
  readonly instanceId: string;
  readonly descriptorId: string;
  readonly attemptId?: string;
}

export interface ProviderOAuthCommandResult {
  readonly kind:
    | "signed-out"
    | "signed-out-locally"
    | "not-revoked"
    | "awaiting-consent"
    | "signed-in"
    | "expired"
    | "refused";
  readonly termsRequired?: boolean;
  readonly accountLabel?: string;
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly reason?: string;
  readonly attemptId?: string;
}

export function ProviderOAuthSignInPanel(props: {
  readonly instanceId: string;
  readonly descriptorId: string;
  readonly accountLabel: string;
  readonly termsSummary: string;
  readonly disabled?: boolean;
  readonly onUseApiKey?: () => void;
  /**
   * Begin the sign-in once, as soon as the host reports the person signed out
   * with no terms left to acknowledge. Set for an endpoint the person just
   * added by choosing the sign-in; the terms still come first when they apply.
   */
  readonly startSignIn?: boolean;
  readonly run?: (command: ProviderOAuthCommand) => Promise<ProviderOAuthCommandResult | undefined>;
  readonly openUrl?: (url: string) => void;
}) {
  const [termsRequired, setTermsRequired] = useState(true);
  const [state, setState] = useState<ProviderOAuthSignInState>({ kind: "signed-out" });
  const [attemptId, setAttemptId] = useState<string>();
  const [statusKnown, setStatusKnown] = useState(false);
  const started = useRef(false);
  const { run, openUrl, instanceId, descriptorId } = props;
  // The settings controller hands this panel a new `run` on every render.
  // Keying the effects on its identity re-ran the status check whenever the
  // settings re-rendered while the person was in the browser, which reset the
  // attempt to signed-out and stopped the poll, so a sign-in the issuer had
  // completed was never collected. The effects read the latest `run` instead.
  const runRef = useRef(run);
  runRef.current = run;
  const canRun = run !== undefined;
  const begin = () => {
    const current = runRef.current;
    if (current === undefined) return;
    void current({ kind: "begin", instanceId, descriptorId }).then((result) => {
      apply(result ?? unreadable, setState, setTermsRequired, setAttemptId, openUrl);
    });
  };

  useEffect(() => {
    const current = runRef.current;
    if (!canRun || current === undefined) return;
    let cancelled = false;
    void current({ kind: "status", instanceId, descriptorId }).then((result) => {
      if (cancelled || result === undefined) return;
      apply(result, setState, setTermsRequired, setAttemptId);
      setStatusKnown(true);
    });
    return () => {
      cancelled = true;
    };
  }, [canRun, descriptorId, instanceId]);

  useEffect(() => {
    if (!canRun || attemptId === undefined || state.kind !== "awaiting-consent") return;
    const timer = setInterval(() => {
      // An unreadable poll answer is a passing failure (the server may be
      // restarting); the next poll asks again until the attempt ends.
      void runRef
        .current?.({
          kind: "poll",
          instanceId,
          descriptorId,
          attemptId,
        })
        .then((result) => {
          if (result === undefined) return;
          apply(result, setState, setTermsRequired, setAttemptId);
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [attemptId, canRun, descriptorId, instanceId, state.kind]);

  useEffect(() => {
    if (props.startSignIn !== true || started.current || !statusKnown) return;
    if (state.kind !== "signed-out" || termsRequired) return;
    started.current = true;
    begin();
  });

  return (
    <ProviderOAuthSignIn
      accountLabel={props.accountLabel}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      onAcknowledge={() => {
        void run?.({
          kind: "acknowledge",
          instanceId,
          descriptorId,
        }).then((result) => {
          if (result === undefined) return;
          apply(result, setState, setTermsRequired, setAttemptId);
        });
      }}
      onSignIn={begin}
      onSignOut={() => {
        void run?.({
          kind: "sign-out",
          instanceId,
          descriptorId,
        }).then((result) => {
          if (result === undefined) return;
          apply(result, setState, setTermsRequired, setAttemptId);
        });
      }}
      onSignOutLocally={() => {
        void run?.({
          kind: "sign-out-locally",
          instanceId,
          descriptorId,
        }).then((result) => {
          if (result === undefined) return;
          apply(result, setState, setTermsRequired, setAttemptId);
        });
      }}
      {...(props.onUseApiKey === undefined ? {} : { onUseApiKey: props.onUseApiKey })}
      state={state}
      termsRequired={termsRequired}
      termsSummary={props.termsSummary}
    />
  );
}

function apply(
  result: ProviderOAuthCommandResult,
  setState: (state: ProviderOAuthSignInState) => void,
  setTermsRequired: (value: boolean) => void,
  setAttemptId: (value: string | undefined) => void,
  openUrl?: (url: string) => void,
) {
  if (result.termsRequired !== undefined) setTermsRequired(result.termsRequired);
  if (result.kind === "signed-out") {
    setAttemptId(undefined);
    setState({ kind: "signed-out" });
    return;
  }
  if (result.kind === "signed-out-locally") {
    setAttemptId(undefined);
    setState({
      kind: "signed-out",
      notice:
        "Signed out on this computer. The sign-in service wasn't told, so the sign-in stays valid there until it expires.",
    });
    return;
  }
  if (result.kind === "not-revoked") {
    setAttemptId(undefined);
    setState({ kind: "not-revoked", accountLabel: result.accountLabel ?? "this account" });
    return;
  }
  if (result.kind === "signed-in") {
    setAttemptId(undefined);
    setState({ kind: "signed-in", accountLabel: result.accountLabel ?? "Signed in" });
    return;
  }
  if (result.kind === "expired") {
    setAttemptId(undefined);
    setState({ kind: "expired" });
    return;
  }
  if (result.kind === "refused") {
    setAttemptId(undefined);
    setState({ kind: "refused", message: refusalMessage(result.reason) });
    return;
  }
  setAttemptId(result.attemptId);
  const href = result.authorizationUrl ?? result.verificationUri;
  if (href !== undefined) openUrl?.(href);
  const detail =
    result.userCode !== undefined
      ? `Enter code ${result.userCode} at the verification page.`
      : "Continue in the browser to finish signing in.";
  setState(
    href === undefined
      ? { kind: "awaiting-consent", detail }
      : { kind: "awaiting-consent", detail, href },
  );
}

/** What a sign-in request that got no readable answer shows: never a silent idle. */
const unreadable: ProviderOAuthCommandResult = { kind: "refused", reason: "unavailable" };

/**
 * A refusal in words a person can act on. The host's reason codes are not
 * shown as they are; an unknown one still says the sign-in did not finish.
 */
function refusalMessage(reason: string | undefined): string {
  switch (reason) {
    case "denied":
      return "The sign-in was cancelled in the browser.";
    case "timeout":
      return "The sign-in took too long. Try signing in again.";
    case "state-mismatch":
    case "verifier-mismatch":
    case "exchange-refused":
      return "The sign-in service refused the sign-in. Try signing in again.";
    case "terms-required":
      return "Acknowledge the terms before signing in.";
    case "local-host-required":
      return "Sign in from Octant on this computer.";
    case "unknown-instance":
    case "unsupported-driver":
    case "endpoint-mismatch":
    case "invalid":
      return "This endpoint can't use this sign-in.";
    case "unavailable":
      return "Octant couldn't finish the sign-in. Try signing in again.";
    default:
      return "Sign-in was refused.";
  }
}
