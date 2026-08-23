import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT } from "../packages/contracts/src/shell";

const packagedBundle = resolve("out/Octant.app");
const REQUIRED_CONTROL_LABELS = [
  "Open checkout in an application.",
  "Toggle environment",
  "Open bottom panel",
  "Open Right sidebar",
  "Show sidebar",
] as const;

export interface NativeWindowBounds {
  readonly x: number;
  readonly y: number;
}

export interface NativeWindowElement {
  readonly label?: string;
  readonly role?: string;
  readonly frame?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

export interface NativeWindowSnapshot {
  readonly window_bounds: NativeWindowBounds;
  readonly elements: ReadonlyArray<NativeWindowElement>;
  readonly screenshot_scale?: number;
}

/**
 * Validates a real CuaDriver window snapshot before the native click pass.
 * The frame is absolute screen geometry; the boundary comparison is made in
 * CSS/window points, not screenshot pixels, so Retina screenshots do not move
 * a target across the hiddenInset boundary.
 */
export function assertNativeTitlebarTargetsBelowInset(
  snapshot: NativeWindowSnapshot,
  inset = NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
  requiredLabels: ReadonlyArray<string> = REQUIRED_CONTROL_LABELS,
): void {
  const available = snapshot.elements.filter(
    (element) => element.role === "AXButton" && element.label !== undefined,
  );
  const targetFor = (label: string) =>
    available.find((element) => element.label === label || element.label?.startsWith(label));
  const missing = requiredLabels.filter((label) => targetFor(label) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Packaged titlebar smoke needs an active Code surface exposing: ${missing.join(", ")}.`,
    );
  }

  for (const label of requiredLabels) {
    const element = targetFor(label);
    const frame = element?.frame;
    if (frame === undefined) throw new Error(`Packaged titlebar target ${label} has no frame.`);
    const centerY = frame.y - snapshot.window_bounds.y + frame.h / 2;
    if (centerY <= inset) {
      throw new Error(
        `Packaged titlebar target ${label} is inside the native movement strip (${centerY}px <= ${inset}px).`,
      );
    }
  }
}

/**
 * Run after packaging and while the Mac is unlocked:
 *
 * 1. Launch `out/Octant.app` with CuaDriver in the background.
 * 2. Open a Code thread with Environment, bottom panel, and dock actions
 *    visible, then capture `get_window_state` as JSON.
 * 3. Pass that JSON here. The script fails before any click if a target is in
 *    the native movement strip; then perform the five CuaDriver pixel clicks
 *    and inspect each post-action snapshot for the expected state change.
 *
 * CuaDriver owns the native click path because DOM/jsdom clicks bypass
 * Electron's titlebar hit testing entirely.
 */
async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Packaged titlebar smoke requires Apple Silicon macOS.");
  }
  await access(packagedBundle);
  const snapshotPath = process.argv[2];
  if (snapshotPath === undefined) {
    throw new Error(
      "Pass a CuaDriver get_window_state JSON snapshot after launching out/Octant.app.",
    );
  }
  const snapshot = JSON.parse(
    await readFile(resolve(snapshotPath), "utf8"),
  ) as NativeWindowSnapshot;
  assertNativeTitlebarTargetsBelowInset(snapshot);
  console.log(
    `Packaged titlebar geometry passed: ${REQUIRED_CONTROL_LABELS.length} controls are below the ${NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT}px native movement strip.`,
  );
  console.log(
    "Next: CuaDriver pixel-click each control and the collapsed sidebar opener, then re-snapshot after every click.",
  );
}

if (import.meta.main) await main();
