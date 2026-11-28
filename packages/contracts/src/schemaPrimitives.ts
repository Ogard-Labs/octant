import { Schema } from "effect";

/** Non-empty trimmed string schema shared across wire and journal contracts. */
export const NonEmptyTrimmedString = Schema.Trimmed.check(Schema.isNonEmpty());

/** UUID/GUID string schema preserving Effect 3's `Schema.UUID` syntax acceptance. */
export const GuidString = Schema.String.check(Schema.isGUID());

/** Non-negative integer schema shared across wire and journal contracts. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Positive integer schema shared across wire and journal contracts. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Strict decode options refusing excess properties on wire and journal contracts. */
export const STRICT_DECODE_OPTIONS = { onExcessProperty: "error" } as const;
