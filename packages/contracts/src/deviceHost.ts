import { Schema } from "effect";

/** The longest address Open URL sends to a device. */
export const DEVICE_OPEN_URL_MAX_LENGTH = 2_048;

/**
 * An address a person asked a Simulator or emulator to open.
 *
 * Only credential-free `http` and `https` addresses, in the form the URL
 * parser writes them back. Every other scheme, including `javascript:`,
 * `file:`, `data:`, and app deep links, is refused: the confirmation must
 * show exactly what the device receives, and a parsed-and-rewritten form is
 * the only one where the shown text and the sent text cannot differ.
 */
export const DeviceOpenUrl = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(DEVICE_OPEN_URL_MAX_LENGTH),
  Schema.filter(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname !== "" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.href === value
      );
    },
    { message: () => "Open URL takes a credential-free http or https address." },
  ),
);
export type DeviceOpenUrl = typeof DeviceOpenUrl.Type;

export const isDeviceOpenUrl = Schema.is(DeviceOpenUrl);
export const decodeDeviceOpenUrl = Schema.decodeUnknownSync(DeviceOpenUrl);

/**
 * The orientation Rotate sets. The pane names the one it is not showing, so
 * the same request means the same thing on a Simulator and an emulator.
 */
export const DeviceOrientation = Schema.Literal("portrait", "landscape");
export type DeviceOrientation = typeof DeviceOrientation.Type;

/**
 * Device actions this host performs beyond the original set, so a pane offers
 * one only once its host says so and never shows it disabled. A host that
 * predates a flag omits it. Flags this renderer does not know are ignored
 * rather than refused, so a newer host can add the next one without breaking
 * an older pane.
 */
export const DeviceHostCapabilities = Schema.Struct({
  openUrl: Schema.optional(Schema.Boolean),
  /** Volume up and down, sent as the `volume-up` and `volume-down` hardware keys. */
  volume: Schema.optional(Schema.Boolean),
  rotate: Schema.optional(Schema.Boolean),
}).annotations({ parseOptions: { onExcessProperty: "ignore" } });
export type DeviceHostCapabilities = typeof DeviceHostCapabilities.Type;
