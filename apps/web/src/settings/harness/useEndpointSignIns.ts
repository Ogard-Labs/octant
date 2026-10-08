import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderOAuthCommand,
  ProviderOAuthCommandResult,
  ProviderOAuthSignInState,
} from "../../providers/ProviderOAuthSignIn";
import type { EndpointSignIn } from "./endpointStatus";

export interface SignInTarget {
  readonly instanceId: string;
  readonly descriptorId: string;
}

/**
 * Each sign-in endpoint's sign-in as the host reports it, so a row can say
 * who is signed in, or that it needs a sign-in, without opening its details.
 * Asking is read-only: the status command starts, acknowledges, and ends
 * nothing.
 */
export function useEndpointSignIns(
  targets: ReadonlyArray<SignInTarget>,
  run:
    | ((command: ProviderOAuthCommand) => Promise<ProviderOAuthCommandResult | undefined>)
    | undefined,
): {
  readonly signIns: ReadonlyMap<string, EndpointSignIn>;
  /** Record what a sign-in panel settled on, so the row agrees with it without asking again. */
  readonly record: (instanceId: string, state: ProviderOAuthSignInState) => void;
} {
  const [signIns, setSignIns] = useState<ReadonlyMap<string, EndpointSignIn>>(new Map());
  // The controller hands a new `run` on every render; asking again on each one
  // would send a status request per render.
  const runRef = useRef(run);
  runRef.current = run;
  const key = targets.map((target) => `${target.instanceId}:${target.descriptorId}`).join("|");
  const canRun = run !== undefined;

  useEffect(() => {
    const current = runRef.current;
    if (!canRun || current === undefined || key === "") return;
    let cancelled = false;
    for (const target of targets) {
      void current({
        kind: "status",
        instanceId: target.instanceId,
        descriptorId: target.descriptorId,
      }).then((result) => {
        if (cancelled) return;
        setSignIns((prior) => new Map(prior).set(target.instanceId, signInOf(result)));
      });
    }
    return () => {
      cancelled = true;
    };
    // `targets` is summarised by `key`; a new array with the same endpoints asks nothing.
  }, [canRun, key]);

  const record = useCallback((instanceId: string, state: ProviderOAuthSignInState) => {
    setSignIns((prior) => {
      const next = signInOfState(state, prior.get(instanceId));
      return next === undefined ? prior : new Map(prior).set(instanceId, next);
    });
  }, []);

  return { signIns, record };
}

function signInOf(result: ProviderOAuthCommandResult | undefined): EndpointSignIn {
  if (result === undefined) return { kind: "unknown" };
  switch (result.kind) {
    case "signed-in":
    case "not-revoked":
      return { kind: "signed-in", accountLabel: result.accountLabel ?? "your account" };
    case "expired":
      return { kind: "expired" };
    case "signed-out":
    case "signed-out-locally":
      return { kind: "signed-out", termsRequired: result.termsRequired === true };
    default:
      return { kind: "unknown" };
  }
}

function signInOfState(
  state: ProviderOAuthSignInState,
  prior: EndpointSignIn | undefined,
): EndpointSignIn | undefined {
  switch (state.kind) {
    case "signed-in":
    case "not-revoked":
      return { kind: "signed-in", accountLabel: state.accountLabel };
    case "expired":
      return { kind: "expired" };
    case "signed-out":
      return {
        kind: "signed-out",
        termsRequired: prior?.kind === "signed-out" ? prior.termsRequired : false,
      };
    default:
      return undefined;
  }
}
