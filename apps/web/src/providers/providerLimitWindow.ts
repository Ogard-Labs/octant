/**
 * The name of a provider's rate-limit window as a person reads it. Providers
 * report machine names ("five_hour", "seven_day"); shown raw they read as
 * "five hour · resets 20:20", which says neither what is limited nor that
 * the figure is a limit.
 */
export function providerLimitWindowLabel(window: string): string {
  const known: Record<string, string> = {
    five_hour: "5-hour limit",
    seven_day: "7-day limit",
    one_day: "24-hour limit",
    one_hour: "1-hour limit",
  };
  return known[window] ?? `${window.replaceAll("_", " ")} limit`;
}
