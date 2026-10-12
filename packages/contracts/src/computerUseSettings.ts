import { Schema } from "effect";

export const ComputerUseSettings = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  // The driver is an upstream binary that runs under Octant's macOS permissions,
  // so a new release waits for a person unless they turned automatic updates on.
  automaticUpdates: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}).annotations({ parseOptions: { onExcessProperty: "error" as const } });
export type ComputerUseSettings = typeof ComputerUseSettings.Type;
export const decodeComputerUseSettings = Schema.decodeUnknownSync(ComputerUseSettings);
