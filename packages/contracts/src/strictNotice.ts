import { Schema } from "effect";

/**
 * One protection Strict kept for a provider launch, beside what the
 * provider's own sandbox and settings already do. The host names only the
 * protections it applied to that launch, so a thread can say what Strict
 * withheld without a reader inferring it from the level.
 *
 * - `octant-sandbox`: the launch ran inside Octant's sandbox.
 * - `protected-files`: every tool, the provider's own included, was refused
 *   Octant's protected files.
 * - `fixed-environment`: the process got Octant's fixed environment instead of
 *   the host's.
 * - `provider-channels-off`: the provider's telemetry, error reports,
 *   feedback and marketplace installs were off.
 * - `octant-project-trust`: only Octant's own Project trust counted, not the
 *   provider CLI's record.
 * - `outside-content-withdrawal`: outside content withdraws provider web
 *   search and the provider's own reviewer.
 * - `forge-asks`: the provider's own pushes, merges and pull-request changes
 *   ask.
 */
export const StrictKeptProtection = Schema.Literal(
  "octant-sandbox",
  "protected-files",
  "fixed-environment",
  "provider-channels-off",
  "octant-project-trust",
  "outside-content-withdrawal",
  "forge-asks",
);
export type StrictKeptProtection = typeof StrictKeptProtection.Type;

/** What Strict kept for one launch, in the fixed order above; never empty. */
export const StrictKeptProtections = Schema.Array(StrictKeptProtection).pipe(
  Schema.minItems(1),
  Schema.maxItems(7),
);
export type StrictKeptProtections = typeof StrictKeptProtections.Type;
