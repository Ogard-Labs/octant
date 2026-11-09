import { Schema } from "effect";
import { StableHostId } from "./remoteAccess";
import { UtcTimestamp } from "./events";

const pin = Schema.String.pipe(Schema.pattern(/^sha256-[A-Za-z0-9_-]{43}$/));

/** A public delegation signed by the listener's previously trusted TLS key. */
export const ListenerKeyTransition = Schema.Struct({
  version: Schema.Literal(1),
  hostId: StableHostId,
  origin: Schema.String.pipe(Schema.maxLength(512)),
  oldPin: pin,
  newPin: pin,
  oldPublicKey: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{122}$/)),
  preparedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{86}$/)),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type ListenerKeyTransition = typeof ListenerKeyTransition.Type;
