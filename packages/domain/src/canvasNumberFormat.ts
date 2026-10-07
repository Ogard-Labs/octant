import type { CanvasNumberFormat } from "@octant/contracts/canvas";

/**
 * The one reading a number gets, wherever a Canvas shows it.
 *
 * Charts, metric blocks, and table columns all name the same closed set of
 * formats, so `bytes` on a table column and `bytes` on a metric read the same
 * way. Locale grouping is the default; a caller that passes no locale gets the
 * runtime's, which is what a renderer should do.
 *
 * Formatting is pure and total: a non-finite value reads as an em dash rather
 * than throwing, because a broken reading is a display concern, not an error
 * the caller can act on.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB"] as const;

const formatterCache = new Map<string, Intl.NumberFormat>();

function numberFormatter(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale ?? "default"}|${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(locale, options);
  formatterCache.set(key, formatter);
  return formatter;
}

function formatBytes(value: number, locale: string | undefined): string {
  const sign = value < 0 ? "-" : "";
  let magnitude = Math.abs(value);
  let unit = 0;
  while (magnitude >= 1024 && unit < BYTE_UNITS.length - 1) {
    magnitude /= 1024;
    unit += 1;
  }
  // Whole bytes are counted, not measured: "1536 B" would be a worse reading
  // than "1.5 KB", and a byte value never carries a decimal.
  const maximumFractionDigits = unit === 0 ? 0 : magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  const formatted = numberFormatter(locale, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(magnitude);
  return `${sign}${formatted} ${BYTE_UNITS[unit] ?? "B"}`;
}

function formatDuration(value: number, locale: string | undefined): string {
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  // A duration is read in seconds; a sub-second value keeps a decimal rather
  // than rounding away to a bare "0s".
  if (magnitude > 0 && magnitude < 1) {
    return `${sign}${numberFormatter(locale, { maximumFractionDigits: 2 }).format(magnitude)}s`;
  }
  let total = Math.round(magnitude);
  const hours = Math.floor(total / 3600);
  total -= hours * 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${String(seconds)}s`);
  return `${sign}${parts.join(" ")}`;
}

export function formatCanvasNumber(
  value: number,
  format?: CanvasNumberFormat,
  locale?: string,
): string {
  if (!Number.isFinite(value)) return "—";
  switch (format) {
    case undefined:
    case "number":
      return numberFormatter(locale, {}).format(value);
    case "compact":
      return numberFormatter(locale, {
        notation: "compact",
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      }).format(value);
    case "percent":
      return numberFormatter(locale, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
    case "bytes":
      return formatBytes(value, locale);
    case "duration":
      return formatDuration(value, locale);
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

/** The same reading with a trailing unit label, for a metric that names one. */
export function formatCanvasNumberWithUnit(
  value: number,
  unit: string | undefined,
  format?: CanvasNumberFormat,
  locale?: string,
): string {
  const formatted = formatCanvasNumber(value, format, locale);
  return unit === undefined || unit.length === 0 ? formatted : `${formatted} ${unit}`;
}
