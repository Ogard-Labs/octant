import { Schema } from "effect";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const BrowserPageScriptRefusalReason = Schema.Literal(
  "full-access-required",
  "plan-is-read-only",
  "local-person-required",
  "stale",
  "held",
  "unavailable",
  "credential-or-frame-protected",
);
export type BrowserPageScriptRefusalReason = typeof BrowserPageScriptRefusalReason.Type;

export const BrowserPageScriptReceipt = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("completed", "truncated", "unsupported-result"),
    effect: Schema.Literal("none", "possible"),
    valueJson: Schema.optional(Schema.String.pipe(Schema.maxLength(24576))),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal(
      "script-failed",
      "timed-out",
      "cancelled",
      "refused",
      "execution-uncertain",
    ),
    effect: Schema.Literal("none", "possible"),
    reason: Schema.optional(BrowserPageScriptRefusalReason),
  }).annotations(strict),
);
export type BrowserPageScriptReceipt = typeof BrowserPageScriptReceipt.Type;

const PlanId = Schema.UUID.pipe(Schema.brand("BrowserPageScriptPlanId"));
export type BrowserPageScriptPlanId = typeof PlanId.Type;
export const decodeBrowserPageScriptPlanId = Schema.decodeUnknownSync(PlanId);
const owner = Schema.Struct({ windowId: WindowId, threadId: BrowserThreadId }).annotations(strict);

/** Private server-to-native operation. Public renderer Browser actions do not accept source. */
export const BrowserPageScriptNativeCommand = Schema.Union(
  Schema.Struct({
    operation: Schema.Literal("prepare"),
    contextId: BrowserContextId,
    owner,
    source: Schema.String.pipe(Schema.maxLength(8192)),
    expectedUrl: Schema.String.pipe(Schema.maxLength(4096)),
    requiresClearPage: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("execute", "cancel"),
    contextId: BrowserContextId,
    owner,
    planId: PlanId,
    requiresClearPage: Schema.optional(Schema.Boolean),
  }).annotations(strict),
);
export type BrowserPageScriptNativeCommand = typeof BrowserPageScriptNativeCommand.Type;

export const BrowserPageScriptPreparation = Schema.Union(
  Schema.Struct({ status: Schema.Literal("prepared"), planId: PlanId }).annotations(strict),
  BrowserPageScriptReceipt,
);
export type BrowserPageScriptPreparation = typeof BrowserPageScriptPreparation.Type;
export const decodeBrowserPageScriptPreparation = Schema.decodeUnknownSync(
  BrowserPageScriptPreparation,
);
export const decodeBrowserPageScriptReceipt = Schema.decodeUnknownSync(BrowserPageScriptReceipt);
export const decodeBrowserPageScriptNativeCommand = Schema.decodeUnknownSync(
  BrowserPageScriptNativeCommand,
);
