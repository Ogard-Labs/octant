import { Schema } from "effect";
import { AppVersion } from "./appUpdates";
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

/**
 * Header that carries a native window's main-only token. Only the native main
 * process sends it; the trusted renderer header decoration strips it.
 */
export const NATIVE_MAIN_AUTHORITY_HEADER = "x-octant-native-main-authority";

/** The window bootstrap protocol a native Nightly client and the host speak. */
export const NIGHTLY_NATIVE_CLIENT_PROTOCOL = 1;

/** Brokered host features a native Nightly main may reach with its main-only token. */
export const NIGHTLY_HOST_FEATURES = [
  "project-root-receipts",
  "local-folder-receipts",
  "runtime-binary-receipts",
  "code-external-editor-target",
  "code-checkout-open-target",
  "preview-handoff",
  "support-bundle-save",
  "code-operation-approval",
  "provider-credentials",
  "provider-api-keys",
] as const;
export const NightlyHostFeature = Schema.Literal(...NIGHTLY_HOST_FEATURES);
export type NightlyHostFeature = typeof NightlyHostFeature.Type;

/**
 * A client reads names it knows and ignores newer ones, so a newer host never
 * refuses an older client's window over a feature that client cannot use.
 */
const AdvertisedHostFeature = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]{0,63}$/));
export const AdvertisedHostFeatures = Schema.Array(AdvertisedHostFeature).pipe(Schema.maxItems(64));
export const decodeAdvertisedHostFeatures = Schema.decodeUnknownSync(AdvertisedHostFeatures);

/**
 * `octant-host-features.json`, attached to each published Octant release: the
 * native client protocol and brokered features that build's host offers a
 * Nightly window, so a Nightly build can be checked against the Octant it
 * will attach to before it is published. Advisory: the asset is unsigned, so
 * it must be signed or hash-pinned before anything outside CI gates on it.
 */
export const OctantHostFeaturesDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  octantVersion: AppVersion,
  /**
   * Any protocol, not only this build's: a newer Octant's document must still
   * read so the reader can report the mismatch rather than call it unreadable.
   */
  nativeClientProtocol: Schema.Int.pipe(Schema.positive()),
  hostFeatures: AdvertisedHostFeatures,
}).annotations(strict);
export type OctantHostFeaturesDocument = typeof OctantHostFeaturesDocument.Type;
export const decodeOctantHostFeaturesDocument = Schema.decodeUnknownSync(
  OctantHostFeaturesDocument,
);

/** Separate from status: only an authenticated window registration returns this. */
export const NightlyWindowBootstrap = Schema.Struct({
  kind: Schema.Literal("registered"),
  protocol: Schema.Literal(NIGHTLY_NATIVE_CLIENT_PROTOCOL),
  windowId: WindowId,
  generation: Generation,
  hostOrigin: HostOrigin,
  hostInstance: Schema.UUID,
  capability: Token,
  rendererIdentity: Token,
  /** Main-only; distinct from the renderer identity. Absent from an older host. */
  nativeMainToken: Schema.optional(Token),
  /** Absent from an older host, which brokers nothing for a native main. */
  hostFeatures: Schema.optional(AdvertisedHostFeatures),
  leaseMs: Schema.Literal(15_000),
}).annotations(strict);
export type NightlyWindowBootstrap = typeof NightlyWindowBootstrap.Type;

export const decodeNativeWindowSource = Schema.decodeUnknownSync(NativeWindowSource);
export const decodeNightlyWindowBootstrap = Schema.decodeUnknownSync(NightlyWindowBootstrap);
