import { BROWSER_TOOL_HOST_LINE } from "@octant/plugin-host/browser-use";
import { COMPUTER_TOOL_HOST_LINE } from "@octant/plugin-host/computer-use";

/** One host line and the tool it describes, so a session without the tool leaves it out. */
export interface AppToolHostLine {
  readonly tool: string;
  readonly text: string;
}

/**
 * The host lines a turn carries for the app tools it offers, one per tool.
 *
 * Browser and Computer are offered on every eligible turn rather than through
 * a composer selection, so each line follows its tool definition: a turn that
 * does not carry the tool is not told about it.
 */
export function appToolHostLines(
  definitions: ReadonlyArray<{ readonly name: string }> | undefined,
): ReadonlyArray<AppToolHostLine> {
  const offered = new Set(definitions?.map((definition) => definition.name) ?? []);
  return [
    ...(offered.has("octant_browser")
      ? [{ tool: "octant_browser", text: BROWSER_TOOL_HOST_LINE }]
      : []),
    ...(offered.has("octant_computer")
      ? [{ tool: "octant_computer", text: COMPUTER_TOOL_HOST_LINE }]
      : []),
  ];
}
