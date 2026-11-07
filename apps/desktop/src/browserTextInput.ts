import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Schema } from "effect";
import type { BrowserWindow } from "electron";
import { BROWSER_TEXT_INPUT_FILENAME } from "./runtimePaths";

const Coordinate = Schema.Number.pipe(Schema.finite(), Schema.between(0, 1920));
const Observation = Schema.Struct({
  status: Schema.Literal("observed"),
  x: Coordinate,
  y: Coordinate,
  width: Coordinate,
  height: Schema.Number.pipe(
    Schema.finite(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(1200),
  ),
});
const decode = Schema.decodeUnknownSync(Observation, { onExcessProperty: "error" });
interface NativeCaret {
  readonly read: (start: number, end: number) => unknown;
  readonly close: () => unknown;
}
function nativeCaret(value: unknown): NativeCaret | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("read" in value) ||
    typeof value.read !== "function" ||
    !("close" in value) ||
    typeof value.close !== "function"
  )
    return undefined;
  const read = value.read,
    close = value.close;
  return {
    read: (start, end) => Reflect.apply(read, value, [start, end]),
    close: () => Reflect.apply(close, value, []),
  };
}

/** Only the owning main binds its own live window. The opaque handle never crosses IPC. */
export function ownBrowserTextInput(window: BrowserWindow) {
  let native: NativeCaret | undefined;
  try {
    if (process.platform === "darwin") {
      const loaded: unknown = createRequire(import.meta.url)(
        resolve(process.resourcesPath, "native", BROWSER_TEXT_INPUT_FILENAME),
      );
      if (
        typeof loaded === "object" &&
        loaded !== null &&
        "bind" in loaded &&
        typeof loaded.bind === "function"
      )
        native = nativeCaret(loaded.bind(window.getNativeWindowHandle()));
    }
  } catch {
    /* An unpackaged or unsupported build has no native caret capability. */
  }
  return {
    read(start: number, end = start) {
      if (
        window.isDestroyed() ||
        native === undefined ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > 1_048_576
      )
        return undefined;
      try {
        const { status: _status, ...caret } = decode(native.read(start, end));
        return caret;
      } catch {
        return undefined;
      }
    },
    close() {
      const owned = native;
      native = undefined;
      try {
        owned?.close();
      } catch {
        /* Already unavailable. */
      }
    },
  };
}
