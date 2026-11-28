import { Schema } from "effect";
import {
  CanvasExportRenderedOutput,
  CanvasExportDelivery,
  CanvasExportLinkChoice,
  CanvasExportLinkTerms,
  CanvasExportVisibility,
} from "@octant/contracts/canvas-export";

export const CANVAS_EXPORT_WORKER_MESSAGE_BYTES = 16_777_216;
export const CANVAS_EXPORT_WORKER_REQUEST_BYTES = 67_108_864;
export const CANVAS_EXPORT_WORKER_PROTOCOL = "canvas-export/1";
const text = Schema.String.pipe(Schema.check(Schema.isMaxLength(4096)));
/** Descriptions are untrusted data; the host approval schema additionally filters displayed text. */
export const CanvasExportWorkerDestination = Schema.Struct({
  path: Schema.optionalKey(text),
  replacesExisting: Schema.optionalKey(Schema.Boolean),
  alsoReplaces: Schema.optionalKey(Schema.Array(text).pipe(Schema.check(Schema.isMaxLength(128)))),
  account: Schema.optionalKey(text),
  visibility: Schema.optionalKey(CanvasExportVisibility),
  note: Schema.optionalKey(text),
  linkTerms: Schema.optionalKey(CanvasExportLinkTerms),
  link: Schema.optionalKey(CanvasExportLinkChoice),
});
export const CanvasExportWorkerRequest = Schema.Struct({
  protocol: Schema.Literal(CANVAS_EXPORT_WORKER_PROTOCOL),
  phase: Schema.Literals(["describe", "export"]),
  output: CanvasExportRenderedOutput,
  confirmed: Schema.optionalKey(CanvasExportWorkerDestination),
});
export const CanvasExportWorkerMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("description"),
    destination: Schema.optionalKey(CanvasExportWorkerDestination),
  }),
  Schema.Struct({ kind: Schema.Literal("delivery"), delivery: CanvasExportDelivery }),
  Schema.Struct({ kind: Schema.Literal("failed") }),
  Schema.Struct({
    kind: Schema.Literal("fetch"),
    id: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
    url: text,
    method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
    headers: Schema.Record(Schema.String.pipe(Schema.check(Schema.isMaxLength(128))), text),
    bodyBase64: Schema.optionalKey(
      Schema.String.pipe(
        Schema.check(Schema.isMaxLength(11_184_812)),
        Schema.check(
          Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        ),
      ),
    ),
  }),
]);
export type CanvasExportWorkerMessage = typeof CanvasExportWorkerMessage.Type;
