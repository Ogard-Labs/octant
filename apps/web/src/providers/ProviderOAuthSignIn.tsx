import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export type ProviderOAuthSignInState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "awaiting-consent"; readonly detail: string }
  | { readonly kind: "signed-in"; readonly accountLabel: string }
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
  readonly onUseApiKey: () => void;
  readonly onSignOut: () => void;
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
      {props.state.kind === "expired" ? <p>Sign in again to use this provider.</p> : null}
      {props.state.kind === "refused" ? <p>{props.state.message}</p> : null}
      {props.state.kind === "awaiting-consent" ? (
        <p aria-live="polite">{props.state.detail}</p>
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
      <OctantButton
        disabled={disabled}
        onClick={props.onUseApiKey}
        size="sm"
        type="button"
        variant="outline"
      >
        Use an API key
      </OctantButton>
      {props.state.kind === "signed-in" ? (
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
    </div>
  );
}

export interface ProviderOAuthCommand {
  readonly kind: "status" | "acknowledge" | "begin" | "poll" | "sign-out";
  readonly instanceId: string;
  readonly descriptorId: string;
  readonly attemptId?: string;
}

export interface ProviderOAuthCommandResult {
  readonly kind: "signed-out" | "awaiting-consent" | "signed-in" | "expired" | "refused";
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
  readonly onUseApiKey: () => void;
  readonly run?: (command: ProviderOAuthCommand) => Promise<ProviderOAuthCommandResult | undefined>;
}) {
  const [termsRequired, setTermsRequired] = useState(true);
  const [state, setState] = useState<ProviderOAuthSignInState>({ kind: "signed-out" });
  const [attemptId, setAttemptId] = useState<string>();

  useEffect(() => {
    if (props.run === undefined) return;
    let cancelled = false;
    void props
      .run({ kind: "status", instanceId: props.instanceId, descriptorId: props.descriptorId })
      .then((result) => {
        if (cancelled || result === undefined) return;
        apply(result, setState, setTermsRequired, setAttemptId);
      });
    return () => {
      cancelled = true;
    };
  }, [props, props.descriptorId, props.instanceId, props.run]);

  useEffect(() => {
    if (props.run === undefined || attemptId === undefined || state.kind !== "awaiting-consent")
      return;
    const timer = setInterval(() => {
      void props
        .run?.({
          kind: "poll",
          instanceId: props.instanceId,
          descriptorId: props.descriptorId,
          attemptId,
        })
        .then((result) => {
          if (result === undefined) return;
          apply(result, setState, setTermsRequired, setAttemptId);
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [attemptId, props, props.descriptorId, props.instanceId, props.run, state.kind]);

  return (
    <ProviderOAuthSignIn
      accountLabel={props.accountLabel}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      onAcknowledge={() => {
        void props
          .run?.({
            kind: "acknowledge",
            instanceId: props.instanceId,
            descriptorId: props.descriptorId,
          })
          .then((result) => {
            if (result === undefined) return;
            apply(result, setState, setTermsRequired, setAttemptId);
          });
      }}
      onSignIn={() => {
        void props
          .run?.({ kind: "begin", instanceId: props.instanceId, descriptorId: props.descriptorId })
          .then((result) => {
            if (result === undefined) return;
            apply(result, setState, setTermsRequired, setAttemptId);
          });
      }}
      onSignOut={() => {
        void props
          .run?.({
            kind: "sign-out",
            instanceId: props.instanceId,
            descriptorId: props.descriptorId,
          })
          .then((result) => {
            if (result === undefined) return;
            apply(result, setState, setTermsRequired, setAttemptId);
          });
      }}
      onUseApiKey={props.onUseApiKey}
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
) {
  if (result.termsRequired !== undefined) setTermsRequired(result.termsRequired);
  if (result.kind === "signed-out") {
    setAttemptId(undefined);
    setState({ kind: "signed-out" });
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
    setState({ kind: "refused", message: result.reason ?? "Sign-in was refused." });
    return;
  }
  setAttemptId(result.attemptId);
  const detail =
    result.userCode !== undefined
      ? `Enter code ${result.userCode} at the verification page.`
      : "Continue in the browser to finish signing in.";
  setState({ kind: "awaiting-consent", detail });
}
