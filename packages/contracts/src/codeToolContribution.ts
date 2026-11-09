import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const token = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z][a-z0-9-]*$/),
);
const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

/** Data-only access to existing host operations; never a command or credential descriptor. */
export const CodeToolContribution = Schema.Struct({
  id: token.pipe(Schema.maxLength(16)),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  description: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  operationIds: Schema.Array(token).pipe(Schema.maxItems(16), Schema.filter(unique)),
  savedCommandIds: Schema.Array(Schema.UUID).pipe(Schema.maxItems(16), Schema.filter(unique)),
})
  .annotations(strict)
  .pipe(Schema.filter((value) => value.operationIds.length + value.savedCommandIds.length > 0));
export type CodeToolContribution = typeof CodeToolContribution.Type;

export const OctantCodeToolsNamespace = Schema.Struct({
  codeTools: Schema.Array(CodeToolContribution).pipe(
    Schema.minItems(1),
    Schema.maxItems(16),
    Schema.filter((values) => new Set(values.map((value) => value.id)).size === values.length),
  ),
}).annotations(strict);
export const decodeOctantCodeToolsNamespace = Schema.decodeUnknownEither(OctantCodeToolsNamespace);
