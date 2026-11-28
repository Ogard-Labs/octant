import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

const token = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);
const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

/** Data-only access to existing host operations; never a command or credential descriptor. */
export const CodeToolContribution = Schema.Struct({
  id: token.check(Schema.isMaxLength(16)),
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  description: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  operationIds: Schema.Array(token).check(Schema.isMaxLength(16), Schema.makeFilter(unique)),
  savedCommandIds: Schema.Array(GuidString).check(
    Schema.isMaxLength(16),
    Schema.makeFilter(unique),
  ),
}).check(
  Schema.makeFilter((value) => value.operationIds.length + value.savedCommandIds.length > 0),
);
export type CodeToolContribution = typeof CodeToolContribution.Type;

export const OctantCodeToolsNamespace = Schema.Struct({
  codeTools: Schema.Array(CodeToolContribution).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.makeFilter((values) => new Set(values.map((value) => value.id)).size === values.length),
  ),
});
export const decodeOctantCodeToolsNamespace = Schema.decodeUnknownResult(
  OctantCodeToolsNamespace,
  STRICT_DECODE_OPTIONS,
);
