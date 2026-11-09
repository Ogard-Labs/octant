import { Schema } from "effect";
import { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "./code";
import { ProviderFileReviewRead, ProviderFileReviewScopeId } from "./providerFileReview";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const scope = { threadId: CodeThreadId, checkoutId: CodeCheckoutId };
export const CodeProviderFileReviewRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("availability"), ...scope }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file"),
    ...scope,
    path: CodeRelativePath,
    scopeId: Schema.optional(ProviderFileReviewScopeId),
  }).annotations(strict),
);
export type CodeProviderFileReviewRequest = typeof CodeProviderFileReviewRequest.Type;
export const CodeProviderFileReviewRead = Schema.Union(
  ProviderFileReviewRead,
  Schema.Struct({ status: Schema.Literal("available") }).annotations(strict),
);
export type CodeProviderFileReviewRead = typeof CodeProviderFileReviewRead.Type;
export const decodeCodeProviderFileReviewRequest = Schema.decodeUnknownSync(
  CodeProviderFileReviewRequest,
);
export const decodeCodeProviderFileReviewRead = Schema.decodeUnknownSync(
  CodeProviderFileReviewRead,
);
