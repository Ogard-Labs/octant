import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";
import { WindowId } from "./shell";

export const BrowserPageScriptRefusalReason = Schema.Literals([
  "full-access-required",
  "plan-is-read-only",
  "local-person-required",
  "stale",
  "held",
  "unavailable",
  "credential-or-frame-protected",
]);
export type BrowserPageScriptRefusalReason = typeof BrowserPageScriptRefusalReason.Type;

export const BrowserPageScriptReceipt = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["completed", "truncated", "unsupported-result"]),
    effect: Schema.Literals(["none", "possible"]),
    valueJson: Schema.optional(Schema.String.check(Schema.isMaxLength(24576))),
  }),
  Schema.Struct({
    status: Schema.Literals([
      "script-failed",
      "timed-out",
      "cancelled",
      "refused",
      "execution-uncertain",
    ]),
    effect: Schema.Literals(["none", "possible"]),
    reason: Schema.optional(BrowserPageScriptRefusalReason),
  }),
]);
export type BrowserPageScriptReceipt = typeof BrowserPageScriptReceipt.Type;

const PlanId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserPageScriptPlanId"),
);
export type BrowserPageScriptPlanId = typeof PlanId.Type;
export const decodeBrowserPageScriptPlanId = Schema.decodeUnknownSync(
  PlanId,
  STRICT_DECODE_OPTIONS,
);
const owner = Schema.Struct({ windowId: WindowId, threadId: BrowserThreadId });

/** Private server-to-native operation. Public renderer Browser actions do not accept source. */
export const BrowserPageScriptNativeCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("prepare"),
    contextId: BrowserContextId,
    owner,
    source: Schema.String.check(Schema.isMaxLength(8192)),
    expectedUrl: Schema.String.check(Schema.isMaxLength(4096)),
    requiresClearPage: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    operation: Schema.Literals(["execute", "cancel"]),
    contextId: BrowserContextId,
    owner,
    planId: PlanId,
    requiresClearPage: Schema.optional(Schema.Boolean),
  }),
]);
export type BrowserPageScriptNativeCommand = typeof BrowserPageScriptNativeCommand.Type;

export const BrowserPageScriptPreparation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("prepared"), planId: PlanId }),
  BrowserPageScriptReceipt,
]);
export type BrowserPageScriptPreparation = typeof BrowserPageScriptPreparation.Type;
export const decodeBrowserPageScriptPreparation = Schema.decodeUnknownSync(
  BrowserPageScriptPreparation,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserPageScriptReceipt = Schema.decodeUnknownSync(
  BrowserPageScriptReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserPageScriptNativeCommand = Schema.decodeUnknownSync(
  BrowserPageScriptNativeCommand,
  STRICT_DECODE_OPTIONS,
);
