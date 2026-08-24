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

export type NativeTitlebarAction =
  | "open-in"
  | "environment"
  | "bottom-panel"
  | "right-dock"
  | "sidebar";

export function assertNativeWindowMoved(
  before: NativeWindowSnapshot,
  after: NativeWindowSnapshot,
  minimumDistance = 8,
): void {
  const deltaX = after.window_bounds.x - before.window_bounds.x;
  const deltaY = after.window_bounds.y - before.window_bounds.y;
  if (Math.hypot(deltaX, deltaY) < minimumDistance) {
    throw new Error(
      `Packaged top-strip drag did not move the native window by ${minimumDistance}px.`,
    );
  }
}

export function assertNativeTitlebarActionResult(
  before: NativeWindowSnapshot,
  after: NativeWindowSnapshot,
  action: NativeTitlebarAction,
): void {
  const labels = after.elements.map((element) => element.label);
  const transitioned =
    action === "bottom-panel"
      ? labels.includes("Close bottom panel")
      : action === "right-dock"
        ? labels.includes("Close Right sidebar")
        : action === "sidebar"
          ? labels.includes("Hide sidebar")
          : action === "open-in"
            ? after.elements.some((element) => element.role === "AXMenuItem")
            : after.elements.some(
                (element) => element.role === "AXDialog" && element.label === "Environment",
              );
  if (!transitioned || before === after) {
    throw new Error(`Packaged titlebar action ${action} did not change its native UI state.`);
  }
}

/**
 * Validates a real CuaDriver window snapshot before the native click pass.
 * The frame is absolute screen geometry; the boundary comparison is made in
 * CSS/window points, not screenshot pixels, so Retina screenshots do not move
 * a target outside the compact title rail.
 */
export function assertNativeTitlebarTargetsInRail(
  snapshot: NativeWindowSnapshot,
  maximumCenterY = NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT + 6,
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
    if (centerY <= 0 || centerY > maximumCenterY) {
      throw new Error(
        `Packaged titlebar target ${label} is outside the compact title rail (${centerY}px not within 0..${maximumCenterY}px).`,
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
 *    the compact native title rail; then perform the five CuaDriver pixel clicks
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
  const snapshot = await readSnapshot(snapshotPath);
  assertNativeTitlebarTargetsInRail(snapshot);
  console.log(
    `Packaged titlebar geometry passed: ${REQUIRED_CONTROL_LABELS.length} controls are in the compact native title rail.`,
  );
  console.log(
    "Next: capture the interaction snapshots, or pass their directory as the second argument to validate them now.",
  );
  const evidenceDirectory = process.argv[3];
  if (evidenceDirectory === undefined) return;
  assertNativeWindowMoved(
    snapshot,
    await readSnapshot(resolve(evidenceDirectory, "after-drag.json")),
  );
  for (const action of [
    "open-in",
    "environment",
    "bottom-panel",
    "right-dock",
    "sidebar",
  ] as const) {
    assertNativeTitlebarActionResult(
      snapshot,
      await readSnapshot(resolve(evidenceDirectory, `after-${action}.json`)),
      action,
    );
  }
  console.log("Packaged titlebar interactions passed: drag and five native actions changed state.");
}

async function readSnapshot(path: string): Promise<NativeWindowSnapshot> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as NativeWindowSnapshot;
}

if (import.meta.main) await main();
