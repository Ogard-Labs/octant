import type { OwnerBrowserRequest, OwnerBrowserResponse } from "@octant/contracts/owner-browser";

export type OwnerBrowserClientResult =
  | OwnerBrowserResponse
  | { readonly status: "not-unlocked"; readonly reason: "cancelled" | "unavailable" }
  | { readonly status: "unreachable" };

export interface OwnerBrowserClient {
  /** Targets use administration consent; takeover always asks for its own exact fresh unlock. */
  readonly browser: (
    command: OwnerBrowserRequest,
    signal?: AbortSignal,
  ) => Promise<OwnerBrowserClientResult>;
}
