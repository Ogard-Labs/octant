import { useEffect, useRef, useState } from "react";
import type { ProviderDeviceSignInBridge } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

// The host follows the attempt itself; this only reads how it stands.
const POLL_INTERVAL_MS = 2_000;

type DeviceSignInState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "terms"; readonly termsSummary: string }
  | {
      readonly kind: "code";
      readonly attemptId: string;
      readonly userCode: string;
      readonly verificationUri: string;
    }
  | { readonly kind: "refused"; readonly message: string };

const COULD_NOT_START = "Octant couldn't start the sign-in. Try again.";

/**
 * An organization sign-in with a device code, shown in a local desktop
 * window. The code may appear here because only this window can reach the
 * host-local sign-in, through the desktop app: a paired device and a remote
 * browser are handed no `request`, and this renders nothing for them. A code
 * shown on a page someone else can reach is how device-code phishing works.
 */
export function DeviceCodeSignIn(props: {
  readonly instanceId: string;
  readonly instanceName: string;
  readonly disabled: boolean;
  readonly request?: ProviderDeviceSignInBridge["providerDeviceSignIn"];
  /** The host now holds the sign-in; the page around this reads it again. */
  readonly onSignedIn: () => void;
  readonly onOpenExternalUrl?: (url: string) => void;
}) {
  const [state, setState] = useState<DeviceSignInState>({ kind: "idle" });
  const { request, instanceId } = props;
  const onSignedInRef = useRef(props.onSignedIn);
  onSignedInRef.current = props.onSignedIn;
  const attemptId = state.kind === "code" ? state.attemptId : undefined;

  useEffect(() => {
    if (request === undefined || attemptId === undefined) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void request({ kind: "poll", instance: instanceId, attemptId })
        .catch(() => undefined)
        .then((answer) => {
          // A poll that never reached the host is tried again on the next tick.
          if (cancelled || answer === undefined) return;
          const outcome = outcomeOf(answer.body);
          if (answer.status === 200 && outcome === "waiting") return;
          if (answer.status === 200 && outcome === "signed-in") {
            setState({ kind: "idle" });
            onSignedInRef.current();
            return;
          }
          setState({ kind: "refused", message: messageOf(answer.body) });
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [request, instanceId, attemptId]);

  if (request === undefined) return null;

  const begin = (acknowledgeTerms: boolean) => {
    setState({ kind: "starting" });
    void request({ kind: "begin", instance: instanceId, acknowledgeTerms })
      .catch(() => undefined)
      .then((answer) => {
        if (answer === undefined) {
          setState({ kind: "refused", message: COULD_NOT_START });
          return;
        }
        if (answer.status !== 200) {
          setState({ kind: "refused", message: messageOf(answer.body) });
          return;
        }
        const body = recordOf(answer.body);
        const outcome = outcomeOf(body);
        if (outcome === "terms-required" && typeof body?.termsSummary === "string") {
          setState({ kind: "terms", termsSummary: body.termsSummary });
          return;
        }
        if (outcome === "signed-in") {
          setState({ kind: "idle" });
          onSignedInRef.current();
          return;
        }
        if (
          outcome === "awaiting-code" &&
          typeof body?.attemptId === "string" &&
          typeof body.userCode === "string" &&
          typeof body.verificationUri === "string" &&
          isHttpsAddress(body.verificationUri)
        ) {
          setState({
            kind: "code",
            attemptId: body.attemptId,
            userCode: body.userCode,
            verificationUri: body.verificationUri,
          });
          return;
        }
        setState({ kind: "refused", message: COULD_NOT_START });
      });
  };

  const busy = state.kind === "starting";
  return (
    <div aria-busy={busy} className="provider-oauth-sign-in">
      {state.kind === "refused" ? <OctantAlert tone="warning">{state.message}</OctantAlert> : null}
      {state.kind === "terms" ? (
        <>
          <p className="provider-oauth-sign-in__consent">
            Signing in accepts these terms: {state.termsSummary}
          </p>
          <OctantButton
            disabled={props.disabled}
            onClick={() => begin(true)}
            size="sm"
            type="button"
            variant="default"
          >
            Agree and show the code
          </OctantButton>
        </>
      ) : null}
      {state.kind === "code" ? (
        <>
          <p>
            Open <span className="oct-meta--mono">{state.verificationUri}</span> and enter this
            code: <code>{state.userCode}</code>
          </p>
          <p className="provider-oauth-sign-in__consent">
            Enter this code only because you just started this sign-in here, on this computer. Never
            enter a sign-in code someone sent you.
          </p>
          <p role="status">Waiting for you to finish at your organization's page…</p>
          {props.onOpenExternalUrl === undefined ? null : (
            <OctantButton
              onClick={() => props.onOpenExternalUrl?.(state.verificationUri)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Open the page
            </OctantButton>
          )}
          <OctantButton
            onClick={() => setState({ kind: "idle" })}
            size="sm"
            type="button"
            variant="secondary"
          >
            Hide the code
          </OctantButton>
        </>
      ) : null}
      {state.kind === "idle" || state.kind === "starting" || state.kind === "refused" ? (
        <OctantButton
          aria-label={`Sign in with a code for ${props.instanceName}`}
          disabled={props.disabled || busy}
          onClick={() => begin(false)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Sign in with a code
        </OctantButton>
      ) : null}
    </div>
  );
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function outcomeOf(body: unknown): string | undefined {
  const outcome = recordOf(body)?.outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

function messageOf(body: unknown): string {
  const message = recordOf(body)?.message;
  return typeof message === "string" && message.length > 0 ? message : COULD_NOT_START;
}

function isHttpsAddress(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
