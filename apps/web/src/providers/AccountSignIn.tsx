import type { ProviderAuthenticationAttempt, ProviderInstanceId } from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

/** How often the card asks whether the person finished signing in. */
const CHECK_INTERVAL_MS = 2_000;

type SignInState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly attempt: ProviderAuthenticationAttempt }
  | { readonly kind: "signed-in" };

/**
 * Signs a Claude Code or Codex subscription account in from its card. The host
 * runs the account's own sign-in command, which opens the browser; the card
 * waits for it to finish, and offers the page again, plus a field for the code
 * a Claude sign-in page shows when the browser could not answer the CLI.
 */
export function AccountSignIn(props: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly disabled: boolean;
  readonly onBegin: (
    instanceId: ProviderInstanceId,
  ) => Promise<ProviderAuthenticationAttempt | undefined>;
  readonly onComplete: (
    instanceId: ProviderInstanceId,
    attemptId: ProviderAuthenticationAttempt["attemptId"],
    code?: string,
  ) => Promise<"completed" | "pending" | "failed">;
  readonly onSignedIn: () => void;
  readonly onOpenExternalUrl?: (url: string) => void;
}) {
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  const [code, setCode] = useState("");
  const latest = useRef(props);
  latest.current = props;

  const attempt = state.kind === "waiting" ? state.attempt : undefined;

  // One way out of waiting for both the regular check and a pasted code, so
  // a sign-in the code finished is not lost to a later check that finds the
  // attempt already gone. Only the first answer for an attempt counts.
  const finishedAttempt = useRef<string | undefined>(undefined);
  const finish = (attemptId: string, outcome: "completed" | "pending" | "failed") => {
    if (outcome === "pending" || finishedAttempt.current === attemptId) return;
    finishedAttempt.current = attemptId;
    if (outcome === "completed") {
      setState({ kind: "signed-in" });
      latest.current.onSignedIn();
    } else {
      setState({ kind: "idle" });
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (attempt === undefined) return undefined;
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (checking || stopped) return;
      if (Date.now() >= Date.parse(attempt.expiresAt)) {
        setState({ kind: "idle" });
        return;
      }
      checking = true;
      const outcome = await latest.current.onComplete(props.instanceId, attempt.attemptId);
      checking = false;
      if (!stopped) finishRef.current(attempt.attemptId, outcome);
    };
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [attempt, props.instanceId]);

  const begin = async () => {
    setState({ kind: "starting" });
    setCode("");
    const started = await props.onBegin(props.instanceId);
    setState(started === undefined ? { kind: "idle" } : { kind: "waiting", attempt: started });
  };

  const openPage = (url: string) => {
    if (props.onOpenExternalUrl !== undefined) props.onOpenExternalUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const submitCode = async () => {
    const value = code.trim();
    if (attempt === undefined || value.length === 0) return;
    setCode("");
    // The CLI takes the code on its input; whether it worked shows on the next check.
    finish(attempt.attemptId, await props.onComplete(props.instanceId, attempt.attemptId, value));
  };

  if (state.kind !== "waiting") {
    return (
      <>
        <OctantButton
          aria-label={`Sign in ${props.displayName}`}
          disabled={props.disabled || state.kind === "starting"}
          onClick={() => void begin()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {state.kind === "starting" ? "Opening sign-in…" : "Sign in"}
        </OctantButton>
        {state.kind === "signed-in" ? (
          <p className="provider-card__guidance" role="status">
            Signed in.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="account-sign-in" role="group" aria-label={`Sign in ${props.displayName}`}>
      <p className="provider-card__guidance" role="status">
        Finish signing in in your browser.
      </p>
      <OctantButton
        onClick={() => openPage(state.attempt.signInUrl)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Open the sign-in page again
      </OctantButton>
      {state.attempt.codeEntry === true ? (
        <form
          className="account-sign-in__code"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode();
          }}
        >
          <OctantInput
            aria-label="Code from the sign-in page"
            autoComplete="off"
            className="settings-view__text-input"
            onChange={(event) => setCode(event.target.value)}
            placeholder="Code from the sign-in page"
            spellCheck={false}
            value={code}
          />
          <OctantButton disabled={code.trim().length === 0} size="sm" type="submit">
            Use code
          </OctantButton>
        </form>
      ) : null}
      <OctantButton
        onClick={() => setState({ kind: "idle" })}
        size="sm"
        type="button"
        variant="ghost"
      >
        Cancel
      </OctantButton>
    </div>
  );
}
