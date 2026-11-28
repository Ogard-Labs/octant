import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "./code";
import { ProviderFileReviewRead, ProviderFileReviewScopeId } from "./providerFileReview";

const scope = { threadId: CodeThreadId, checkoutId: CodeCheckoutId };
export const CodeProviderFileReviewRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("availability"), ...scope }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    ...scope,
    path: CodeRelativePath,
    scopeId: Schema.optional(ProviderFileReviewScopeId),
  }),
]);
export type CodeProviderFileReviewRequest = typeof CodeProviderFileReviewRequest.Type;
export const CodeProviderFileReviewRead = Schema.Union([
  ProviderFileReviewRead,
  Schema.Struct({ status: Schema.Literal("available") }),
]);
export type CodeProviderFileReviewRead = typeof CodeProviderFileReviewRead.Type;
export const decodeCodeProviderFileReviewRequest = Schema.decodeUnknownSync(
  CodeProviderFileReviewRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProviderFileReviewRead = Schema.decodeUnknownSync(
  CodeProviderFileReviewRead,
  STRICT_DECODE_OPTIONS,
);
