import { Schema } from "effect";

/**
 * A provider runtime's own id for a session it keeps, as it lists it. Opaque
 * and path-free, so it can name the session and nothing else. Work and Code
 * threads both name an adopted session by it.
 */
export const ProviderNativeSessionId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
export type ProviderNativeSessionId = typeof ProviderNativeSessionId.Type;
