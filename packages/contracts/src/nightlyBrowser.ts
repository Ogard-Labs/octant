import { Schema } from "effect";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Token = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/));
const Generation = Schema.Number.pipe(Schema.int(), Schema.between(1, Number.MAX_SAFE_INTEGER));

/** A host origin comes from Stable's running host descriptor, never a request. */
const HostOrigin = Schema.String.pipe(
  Schema.maxLength(128),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
        url.origin === value &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
);

export const NativeWindowSource = Schema.Struct({
  kind: Schema.Literal("native-nightly"),
  processRegistration: Token,
  incarnation: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  generation: Generation,
}).annotations(strict);
export type NativeWindowSource = typeof NativeWindowSource.Type;

/** Separate from status: only an authenticated window registration returns this. */
export const NightlyWindowBootstrap = Schema.Struct({
  kind: Schema.Literal("registered"),
  protocol: Schema.Literal(1),
  windowId: WindowId,
  generation: Generation,
  hostOrigin: HostOrigin,
  hostInstance: Schema.UUID,
  capability: Token,
  rendererIdentity: Token,
  leaseMs: Schema.Literal(15_000),
}).annotations(strict);
export type NightlyWindowBootstrap = typeof NightlyWindowBootstrap.Type;

export const decodeNativeWindowSource = Schema.decodeUnknownSync(NativeWindowSource);
export const decodeNightlyWindowBootstrap = Schema.decodeUnknownSync(NightlyWindowBootstrap);
