/**
 * A provider's rate-limit window as a person reads it. Providers report
 * machine names ("five_hour", "seven_day", "<scope>:primary_7d"); shown raw
 * they read as "five hour · resets 20:20" or "<scope>:primary 7d limit", which
 * says neither how long the window is nor that the figure is a limit.
 */
export interface ProviderLimitWindowName {
  readonly label: string;
  /**
   * What the provider said the window meters (a plan or model id), when the
   * window id carried one. It is the provider's spelling, kept so two windows
   * of the same length on different scopes stay apart.
   */
  readonly scope?: string;
}

const KNOWN_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5-hour limit",
  seven_day: "7-day limit",
  one_day: "24-hour limit",
  one_hour: "1-hour limit",
};

export function providerLimitWindowName(window: string): ProviderLimitWindowName {
  const separator = window.lastIndexOf(":");
  const scope = separator < 0 ? "" : window.slice(0, separator).trim();
  const label = localWindowLabel(separator < 0 ? window : window.slice(separator + 1));
  return scope.length === 0 ? { label } : { label, scope };
}

export function providerLimitWindowLabel(window: string): string {
  return providerLimitWindowName(window).label;
}

const UNIT_SUFFIX: Readonly<Record<string, string>> = { minute: "m", hour: "h", day: "d" };

/**
 * The short name a narrow bar can carry: "5h", "Week". A seven-day window is
 * the provider's weekly limit, so it reads as "Week". A window whose length
 * is not a plain duration keeps its full label.
 */
export function providerLimitWindowShortLabel(window: string): string {
  const { label } = providerLimitWindowName(window);
  const duration = /^(\d+)-(minute|hour|day) limit$/.exec(label);
  if (duration === null) return label;
  const [, amount = "", unit = ""] = duration;
  if (unit === "day" && amount === "7") return "Week";
  return `${amount}${UNIT_SUFFIX[unit] ?? ""}`;
}

/**
 * Slot windows are named by slot and length (`primary_5h`, `secondary_7d`).
 * The length is what a reader recognizes, so it becomes the label; the slot
 * only names which of the provider's two windows this is.
 */
function localWindowLabel(local: string): string {
  const known = KNOWN_WINDOWS[local];
  if (known !== undefined) return known;
  const slot = /^(primary|secondary)(?:_(\d+)([mhd]))?$/.exec(local);
  if (slot === null) return `${local.replaceAll("_", " ")} limit`;
  const [, name = "", amount, unit] = slot;
  if (amount === undefined || unit === undefined) {
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} limit`;
  }
  return `${amount}-${durationUnit(unit)} limit`;
}

function durationUnit(unit: string): string {
  if (unit === "m") return "minute";
  if (unit === "h") return "hour";
  return "day";
}
