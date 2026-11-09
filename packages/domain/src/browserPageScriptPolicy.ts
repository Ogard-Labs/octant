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
  readonly scopedPermission?: boolean;
}): BrowserPageScriptDecision {
  if (input.caller !== "person") return { status: "refused", reason: "local-person-required" };
  if (input.executionPolicy === "plan") return { status: "refused", reason: "plan-is-read-only" };
  // A scoped permission explicitly grants page account authority, even in Private.
  if (input.executionPolicy !== "full-access" && input.scopedPermission !== true)
    return { status: "refused", reason: "full-access-required" };
  return { status: "allowed" };
}
