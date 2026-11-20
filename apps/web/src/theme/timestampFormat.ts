import type { ThemeTimestampFormat } from "@octant/contracts";

/**
 * Clock-format preference passed by reactive React callers:
 * - `"12h"` / `"24h"`: force a 12-hour or 24-hour clock
 * - `null`: explicitly unset (use the locale default — never fall back to a
 *   potentially stale `document.documentElement.dataset.octantTimestampFormat`)
 * - `undefined` (omitted): imperative caller requesting document-root lookup
 */
export type TimestampFormatPreference = ThemeTimestampFormat | null;

/**
 * Reads the active theme timestamp preference published on the document root
 * (`data-octant-timestamp-format`). Returns `undefined` when unset so callers
 * fall back to the locale's default clock cycle.
 */
export function readActiveTimestampFormat(): ThemeTimestampFormat | undefined {
  if (typeof document === "undefined") return undefined;
  const value = document.documentElement.dataset.octantTimestampFormat;
  return value === "12h" || value === "24h" ? value : undefined;
}

/**
 * Converts a theme timestamp format into the `Intl.DateTimeFormatOptions`
 * `hour12` setting.
 *
 * Passing `null` explicitly selects the locale default without consulting the
 * document root attribute. Omitting `format` (`undefined`) reads the document
 * root attribute for imperative non-React callers.
 */
export function timestampFormatHour12(format?: TimestampFormatPreference): boolean | undefined {
  if (format === null) return undefined;
  const effective = format ?? readActiveTimestampFormat();
  if (effective === "12h") return true;
  if (effective === "24h") return false;
  return undefined;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function withHour12(
  options: Intl.DateTimeFormatOptions | undefined,
  format: TimestampFormatPreference | undefined,
): Intl.DateTimeFormatOptions | undefined {
  const hour12 = timestampFormatHour12(format);
  if (hour12 === undefined) return options;
  return { ...options, hour12 };
}

/**
 * Formats a clock time honoring the theme's `timestampFormat` (`12h` or `24h`)
 * when configured, falling back to the locale default otherwise.
 */
export function formatClockTime(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  format?: TimestampFormatPreference,
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  const resolved = withHour12(options, format);
  return resolved === undefined
    ? date.toLocaleTimeString()
    : date.toLocaleTimeString(undefined, resolved);
}

/**
 * Formats a date and time honoring the theme's `timestampFormat` (`12h` or `24h`)
 * when configured, falling back to the locale default otherwise.
 */
export function formatDateTime(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  format?: TimestampFormatPreference,
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  const resolved = withHour12(options, format);
  return resolved === undefined ? date.toLocaleString() : date.toLocaleString(undefined, resolved);
}
