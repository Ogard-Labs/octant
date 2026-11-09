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
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const text = Schema.String.pipe(Schema.maxLength(4096));
/** Descriptions are untrusted data; the host approval schema additionally filters displayed text. */
export const CanvasExportWorkerDestination = Schema.Struct({
  path: Schema.optionalWith(text, { exact: true }),
  replacesExisting: Schema.optionalWith(Schema.Boolean, { exact: true }),
  alsoReplaces: Schema.optionalWith(Schema.Array(text).pipe(Schema.maxItems(128)), { exact: true }),
  account: Schema.optionalWith(text, { exact: true }),
  visibility: Schema.optionalWith(CanvasExportVisibility, { exact: true }),
  note: Schema.optionalWith(text, { exact: true }),
  linkTerms: Schema.optionalWith(CanvasExportLinkTerms, { exact: true }),
  link: Schema.optionalWith(CanvasExportLinkChoice, { exact: true }),
}).annotations(strict);
export const CanvasExportWorkerRequest = Schema.Struct({
  protocol: Schema.Literal(CANVAS_EXPORT_WORKER_PROTOCOL),
  phase: Schema.Literal("describe", "export"),
  output: CanvasExportRenderedOutput,
  confirmed: Schema.optionalWith(CanvasExportWorkerDestination, { exact: true }),
}).annotations(strict);
export const CanvasExportWorkerMessage = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("description"),
    destination: Schema.optionalWith(CanvasExportWorkerDestination, { exact: true }),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("delivery"), delivery: CanvasExportDelivery }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("failed") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("fetch"),
    id: Schema.Int.pipe(Schema.between(1, 8)),
    url: text,
    method: Schema.Literal("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"),
    headers: Schema.Record({ key: Schema.String.pipe(Schema.maxLength(128)), value: text }),
    bodyBase64: Schema.optionalWith(
      Schema.String.pipe(
        Schema.maxLength(11_184_812),
        Schema.pattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      ),
      { exact: true },
    ),
  }).annotations(strict),
);
export type CanvasExportWorkerMessage = typeof CanvasExportWorkerMessage.Type;
