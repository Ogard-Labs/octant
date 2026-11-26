import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const StoredComputerUseSettings = Schema.Struct({
  setupPending: Schema.optional(Schema.Boolean),
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  automaticUpdates: Schema.optional(Schema.Boolean),
  /** Written only when the person sets the switch, so their choice outlives a default change. */
  automaticUpdatesChosen: Schema.optional(Schema.Literal(true)),
}).annotations(strict);

const DecodedComputerUseSettings = Schema.Struct({
  setupPending: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  automaticUpdates: Schema.Boolean,
  automaticUpdatesChosen: Schema.optional(Schema.Literal(true)),
}).annotations(strict);

/**
 * The driver updates itself unless the person turned that off (maintainer
 * decision, 2026-11-26). A store written while updates were off by default
 * holds `automaticUpdates: false` whether or not anyone chose it, because the
 * old default was saved with every settings write; only a recorded choice
 * keeps updates off.
 */
export const ComputerUseSettings = Schema.transform(
  StoredComputerUseSettings,
  DecodedComputerUseSettings,
  {
    strict: true,
    decode: ({ automaticUpdates, automaticUpdatesChosen, ...rest }) =>
      automaticUpdatesChosen === true
        ? { ...rest, automaticUpdates: automaticUpdates ?? true, automaticUpdatesChosen }
        : { ...rest, automaticUpdates: true },
    encode: (settings) => settings,
  },
);
export type ComputerUseSettings = typeof ComputerUseSettings.Type;
export const decodeComputerUseSettings = Schema.decodeUnknownSync(ComputerUseSettings);
