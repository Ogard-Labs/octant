// Pure rules of hub-started sign-in: whether a spoke takes the hub's request to
// sign in to a provider account, when a request lapses, and how many a requester
// may send in an hour. A request is a question for the person on the spoke; none
// of these rules starts a sign-in, and the hub learns only an outcome word.

import {
  HUB_SIGN_IN_HOURLY_LIMIT,
  HUB_SIGN_IN_KINDS,
  type HubSignInKind,
  type HubSignInReason,
} from "@octant/contracts";

export type SignInAdmission =
  | { readonly status: "admit"; readonly kind: HubSignInKind }
  | {
      readonly status: "refuse";
      readonly kind: Extract<
        HubSignInReason,
        | "sign-in-not-granted"
        | "unknown-kind"
        | "rate-limited"
        | "already-asked"
        | "already-signed-in"
      >;
    };

export function isHubSignInKind(text: string): text is HubSignInKind {
  return (HUB_SIGN_IN_KINDS as ReadonlyArray<string>).includes(text);
}

/**
 * Whether the spoke asks its person about a request. The checks run so that the
 * hub learns as little as possible from a refusal: the grant first, then the
 * kind, then the hourly limit (which counts every request that got this far, so
 * repeated asking cannot be used to probe), then what the spoke already holds.
 * `signedIn` is `undefined` when this host cannot tell, which is not a refusal.
 */
export function decideSignInAdmission(input: {
  readonly granted: boolean;
  readonly kind: string;
  readonly supportedKinds: ReadonlyArray<HubSignInKind>;
  /** How many requests from this requester arrived in the last hour, before this one. */
  readonly recentRequests: number;
  readonly alreadyAsked: boolean;
  readonly signedIn: boolean | undefined;
}): SignInAdmission {
  if (!input.granted) return { status: "refuse", kind: "sign-in-not-granted" };
  const kind = input.kind;
  if (!isHubSignInKind(kind) || !input.supportedKinds.includes(kind)) {
    return { status: "refuse", kind: "unknown-kind" };
  }
  if (input.recentRequests >= HUB_SIGN_IN_HOURLY_LIMIT) {
    return { status: "refuse", kind: "rate-limited" };
  }
  if (input.alreadyAsked) return { status: "refuse", kind: "already-asked" };
  if (input.signedIn === true) return { status: "refuse", kind: "already-signed-in" };
  return { status: "admit", kind };
}

/** Splits requests into those still open and those past their time. */
export function settleSignInRequests<T extends { readonly expiresAtMs: number }>(
  requests: ReadonlyArray<T>,
  nowMs: number,
): { readonly open: ReadonlyArray<T>; readonly expired: ReadonlyArray<T> } {
  return {
    open: requests.filter((request) => request.expiresAtMs > nowMs),
    expired: requests.filter((request) => request.expiresAtMs <= nowMs),
  };
}
