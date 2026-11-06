import type { ProviderExecutionPolicy } from "@octant/contracts";
import type { BrowserProfileCaller } from "./browserProfilePolicy";

export type BrowserPageScriptDecision =
  | { readonly status: "allowed" }
  | {
      readonly status: "refused";
      readonly reason: "plan-is-read-only" | "full-access-required" | "local-person-required";
    };

export function evaluateBrowserPageScriptPolicy(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly caller: BrowserProfileCaller;
}): BrowserPageScriptDecision {
  if (input.caller !== "person") return { status: "refused", reason: "local-person-required" };
  if (input.executionPolicy === "plan") return { status: "refused", reason: "plan-is-read-only" };
  // Private is a storage lifecycle, not evidence that a page has no signed-in session.
  if (input.executionPolicy !== "full-access")
    return { status: "refused", reason: "full-access-required" };
  return { status: "allowed" };
}
