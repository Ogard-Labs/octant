import { BROWSER_TOOL_HOST_LINE } from "@octant/plugin-host/browser-use";
import { COMPUTER_TOOL_HOST_LINE } from "@octant/plugin-host/computer-use";

/**
 * The host lines a turn carries for the app tools it offers, one per tool.
 *
 * Browser and Computer are offered on every eligible turn rather than through
 * a composer selection, so each line follows its tool definition: a turn that
 * does not carry the tool is not told about it.
 */
export function appToolHostLines(
  definitions: ReadonlyArray<{ readonly name: string }> | undefined,
): ReadonlyArray<string> {
  const offered = new Set(definitions?.map((definition) => definition.name) ?? []);
  return [
    ...(offered.has("octant_browser") ? [BROWSER_TOOL_HOST_LINE] : []),
    ...(offered.has("octant_computer") ? [COMPUTER_TOOL_HOST_LINE] : []),
  ];
}
