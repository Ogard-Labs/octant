import { Effect, Schema, SchemaTransformation } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

const StoredComputerUseSettings = Schema.Struct({
  setupPending: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
  automaticUpdates: Schema.optional(Schema.Boolean),
  /** Written only when the person sets the switch, so their choice outlives a default change. */
  automaticUpdatesChosen: Schema.optional(Schema.Literal(true)),
});

const DecodedComputerUseSettings = Schema.Struct({
  setupPending: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  automaticUpdates: Schema.Boolean,
  automaticUpdatesChosen: Schema.optional(Schema.Literal(true)),
});

/**
 * The driver updates itself unless the person turned that off (maintainer
 * decision, 2026-11-26). A store written while updates were off by default
 * holds `automaticUpdates: false` whether or not anyone chose it, because the
 * old default was saved with every settings write; only a recorded choice
 * keeps updates off.
 */
export const ComputerUseSettings = StoredComputerUseSettings.pipe(
  Schema.decodeTo(
    DecodedComputerUseSettings,
    SchemaTransformation.transform({
      decode: ({
        automaticUpdates,
        automaticUpdatesChosen,
        ...rest
      }): typeof DecodedComputerUseSettings.Type =>
        automaticUpdatesChosen === true
          ? { ...rest, automaticUpdates: automaticUpdates ?? true, automaticUpdatesChosen }
          : { ...rest, automaticUpdates: true },
      encode: (settings) => settings,
    }),
  ),
);
export type ComputerUseSettings = typeof ComputerUseSettings.Type;
export const decodeComputerUseSettings = Schema.decodeUnknownSync(
  ComputerUseSettings,
  STRICT_DECODE_OPTIONS,
);
