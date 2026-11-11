import {
  CanvasVersion,
  decodeCanvasVersion,
  type CanvasDefinition,
  type CanvasDesignSystem,
} from "@octant/contracts/canvas";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import {
  decodeCanvasDesignSystemApplyCommand,
  type CanvasDesignSystemApplyCommand,
} from "@octant/contracts/canvas-board";
import type { UtcTimestamp } from "@octant/contracts";
import { designBrandTokenRefusal } from "./canvasDesignFrameKit";
import { validateCanvasDefinition } from "./canvasPolicy";
import type { CanvasDiagramLayoutRevisionAdmitResult } from "./canvasBoardPolicy";

/** How many categorical series colours typed blocks cycle through. */
export const CANVAS_SERIES_COUNT = 6;

/**
 * The colour a typed block's series takes from a design system, or undefined
 * where the design system names none and the reader's theme keeps its own.
 * A design system names its chart palette `color-chart-1` to `color-chart-6`
 * (`chart-1:` under `colors:` in DESIGN.md); without one, its primary colour
 * leads and its secondary follows. Status tones (success, warning, danger)
 * and text stay the theme's, because they are tuned for contrast on the
 * reader's light or dark scheme and a brand's are usually tuned for one.
 */
export function canvasDesignSystemSeries(
  brand: Readonly<Record<string, string>>,
): ReadonlyArray<string | undefined> {
  const safe = (name: string): string | undefined => {
    const value = brand[name];
    return value === undefined || designBrandTokenRefusal(name, value) !== undefined
      ? undefined
      : value.trim();
  };
  return Array.from({ length: CANVAS_SERIES_COUNT }, (_, index) => {
    const chart = safe(`color-chart-${String(index + 1)}`);
    if (chart !== undefined) return chart;
    if (index === 0) return safe("color-primary");
    if (index === 1) return safe("color-secondary");
    return undefined;
  });
}

/**
 * The custom properties a Canvas sets on its typed blocks so they draw with
 * its design system: each series colour it names, and its primary colour as
 * the accent a progress bar or a highlighted bar fills with. Every value
 * passes the brand rule again, wherever it came from, so nothing written can
 * end a declaration.
 */
export function canvasDesignSystemProperties(
  designSystem: Pick<CanvasDesignSystem, "brand"> | undefined,
): ReadonlyArray<readonly [name: string, value: string]> {
  if (designSystem === undefined) return [];
  const properties: Array<readonly [string, string]> = [];
  canvasDesignSystemSeries(designSystem.brand).forEach((value, index) => {
    if (value !== undefined) properties.push([`--oct-series-${String(index + 1)}`, value]);
  });
  const primary = designSystem.brand["color-primary"];
  if (primary !== undefined && designBrandTokenRefusal("color-primary", primary) === undefined) {
    properties.push(["--oct-accent", primary.trim()]);
  }
  return properties;
}

/**
 * The definition with a design system applied: the Canvas follows it (or,
 * with undefined, none), and every design already drawn in a brand is redrawn
 * in the new one, so a swap changes the whole document at once. A design that
 * keeps the workspace theme or its own palette is left as its author made it.
 * Swapping to none leaves brand designs as they are: their brand is theirs.
 */
export function applyCanvasDesignSystem(
  definition: CanvasDefinition,
  designSystem: CanvasDesignSystem | undefined,
): CanvasDefinition {
  const { designSystem: _previous, ...rest } = definition;
  if (designSystem === undefined) return rest;
  return {
    ...rest,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    designSystem,
    blocks: definition.blocks.map((block) =>
      block.kind === "design" && block.theme === "brand"
        ? { ...block, brand: designSystem.brand }
        : block,
    ),
  };
}

/**
 * Admit a person's switch of the Canvas's design system as a new version of
 * the head it targets. The host has already read the chosen file into
 * `designSystem`; this checks the request against the head and revalidates
 * the whole definition, so the switch journals only what a person could have
 * written by hand.
 */
export function admitCanvasDesignSystemApply(
  input: unknown,
  current: CanvasVersion,
  designSystem: CanvasDesignSystem | undefined,
  now: UtcTimestamp,
): CanvasDiagramLayoutRevisionAdmitResult {
  let command: CanvasDesignSystemApplyCommand;
  try {
    command = decodeCanvasDesignSystemApplyCommand(input);
  } catch {
    return reject("malformed-request", "Canvas design system switch is malformed.");
  }
  if (command.actor.kind !== "local-user" && command.actor.kind !== "agent") {
    return reject(
      "unauthorized",
      "Canvas design system switch must be authored by a user or agent.",
    );
  }
  if (command.expectedSequence !== current.sequence) {
    return reject("stale-version", "Canvas design system switch targets a stale Canvas sequence.");
  }
  if (
    String(command.canvasId) !== String(current.canvasId) ||
    String(command.versionId) === String(current.versionId)
  ) {
    return reject("malformed-request", "Canvas design system switch targets the wrong version.");
  }
  if ((command.designSystem === null) !== (designSystem === undefined)) {
    return reject("malformed-request", "Canvas design system switch was not resolved.");
  }
  if (designSystem === undefined && current.definition.designSystem === undefined) {
    return reject("malformed-request", "This Canvas follows no design system already.");
  }
  let definition: CanvasDefinition;
  try {
    definition = validateCanvasDefinition(
      applyCanvasDesignSystem(current.definition, designSystem),
    );
  } catch (error) {
    return reject(
      "malformed-request",
      error instanceof Error ? error.message : "Canvas design system switch failed validation.",
    );
  }
  const next: CanvasVersion = {
    schemaVersion: current.schemaVersion,
    canvasId: current.canvasId,
    versionId: command.versionId,
    sequence: current.sequence + 1,
    definition,
    createdBy: command.actor,
    createdAt: now,
  };
  try {
    decodeCanvasVersion(next);
  } catch {
    return reject("malformed-request", "Canvas design system switch produced an invalid version.");
  }
  return { kind: "accepted", next };
}

function reject(
  code: "malformed-request" | "stale-version" | "unauthorized",
  message: string,
): CanvasDiagramLayoutRevisionAdmitResult {
  return { kind: "rejected", code, message };
}
