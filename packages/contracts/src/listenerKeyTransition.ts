import { Schema } from "effect";
import { StableHostId } from "./remoteAccess";
import { UtcTimestamp } from "./events";

const pin = Schema.String.check(Schema.isPattern(/^sha256-[A-Za-z0-9_-]{43}$/));

/** A public delegation signed by the listener's previously trusted TLS key. */
export const ListenerKeyTransition = Schema.Struct({
  version: Schema.Literal(1),
  hostId: StableHostId,
  origin: Schema.String.check(Schema.isMaxLength(512)),
  oldPin: pin,
  newPin: pin,
  oldPublicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{122}$/)),
  preparedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type ListenerKeyTransition = typeof ListenerKeyTransition.Type;
