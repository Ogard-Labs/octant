import { Schema } from "effect";

export const ComputerUseSettings = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  automaticUpdates: Schema.optionalWith(Schema.Boolean, { default: () => true }),
}).annotations({ parseOptions: { onExcessProperty: "error" as const } });
export type ComputerUseSettings = typeof ComputerUseSettings.Type;
export const decodeComputerUseSettings = Schema.decodeUnknownSync(ComputerUseSettings);
