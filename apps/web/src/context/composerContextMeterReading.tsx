import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { matchKeybinding } from "@octant/domain";
import { useEffect } from "react";
import { isApplePlatform } from "../platform";
import { useKeybindings } from "../keybindings/useKeybindings";
import {
  compactTokenCount,
  contextWindowModel,
  providerWindowModel,
  type ContextWindowSegment,
  type ProviderWindowModel,
} from "./contextInspectorModel";
import {
  useComposerContextMeterScope,
  type ComposerContextUsageFallback,
} from "./composerContextMeterScope";

export const NO_USAGE_REPORTED = "This provider reports no usage, so there is no context meter.";
/**
 * An ACP agent's turns carry no usage, so no figure is late: there will never
 * be one. Said wherever the meter would otherwise wait for a window, whether
 * the thread is provider-run (Code) or planned by Octant (Work, Chat).
 */

export function ComposerContextMeterShortcut() {
  const { requestOpen } = useComposerContextMeterScope();
  const { keybindings } = useKeybindings();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "context-usage") return;
      // The workspace stays mounted behind Settings' sheet. Opening the meter
      // there would put a popover behind the scrim and take the keyboard out
      // of the sheet.
      if (document.querySelector(".octant-sheet__popup") !== null) return;
      event.preventDefault();
      requestOpen();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, requestOpen]);
  return null;
}

/**
 * How full the window is, from the same two sources the meter itself reads: the
 * host's context plan, or, where no plan exists, the provider's own report.
 * Absent when neither names a window, so a caller shows nothing rather than a
 * guessed share.
 */
export function composerContextOccupancy(input: {
  readonly snapshot?: ContextInspectorSnapshot | undefined;
  readonly fallback?: ComposerContextUsageFallback | undefined;
}):
  | {
      readonly usedTokens: number;
      readonly totalTokens: number;
      readonly percent: number;
      readonly label: string;
    }
  | undefined {
  const reading = composerContextReading(input);
  if (reading.kind !== "window") return undefined;
  return {
    usedTokens: reading.usedTokens,
    totalTokens: reading.totalTokens,
    percent: reading.percent,
    label: reading.label,
  };
}

/**
 * What the host knows about how full a thread's window is: the share against a
 * named maximum, the used figure alone when no maximum is named, or nothing.
 * The composer's ring, the dock overview and the Environment strip's Context
 * section all read this one answer, so they cannot disagree. It never
 * estimates: a window nothing named has no share, and a thread nothing
 * reported on has no figure.
 */
export type ComposerContextReading =
  | {
      readonly kind: "window";
      readonly usedTokens: number;
      readonly totalTokens: number;
      readonly percent: number;
      readonly label: string;
      /** The parts the host or the provider reported, without free or reserved room. */
      readonly segments: ReadonlyArray<ContextWindowSegment>;
    }
  | { readonly kind: "used"; readonly usedTokens: number }
  | { readonly kind: "none" };

/**
 * The share of the model's window the provider itself reported with its last
 * turn. A runtime the host does not plan has no context plan to measure, so
 * the provider's own figure is the window the meter shows. When the usage
 * report named the occupancy but not the window, the limit the provider
 * declared for the selected model stands in — the popover says whose number
 * it is.
 */

export function composerContextReading(input: {
  readonly snapshot?: ContextInspectorSnapshot | undefined;
  readonly fallback?: ComposerContextUsageFallback | undefined;
}): ComposerContextReading {
  if (input.snapshot !== undefined) {
    const model = contextWindowModel(input.snapshot);
    if (model.totalTokens === undefined || model.percent === undefined || model.totalTokens <= 0) {
      // Entries Octant could not count make the used figure a floor, not a reading.
      return model.usedSource === "unknown"
        ? { kind: "none" }
        : { kind: "used", usedTokens: model.usedTokens };
    }
    return {
      kind: "window",
      usedTokens: model.usedTokens,
      totalTokens: model.totalTokens,
      percent: model.percent,
      label: `${compactTokens(model.usedTokens)} of ${compactTokens(model.totalTokens)}`,
      segments: heldSegments(model.segments),
    };
  }
  const fallback = input.fallback;
  if (fallback === undefined) return { kind: "none" };
  const reported = reportedWindow(fallback);
  if (reported !== undefined) {
    return {
      kind: "window",
      usedTokens: reported.usedTokens,
      totalTokens: reported.windowTokens,
      percent: reported.percent,
      label: `${compactTokens(reported.usedTokens)} of ${compactTokens(reported.windowTokens)}`,
      segments: heldSegments(reported.model.segments),
    };
  }
  return fallback.contextTokens === undefined
    ? { kind: "none" }
    : { kind: "used", usedTokens: fallback.contextTokens };
}

/**
 * The parts that fill the window. A bare "Used" segment is the whole figure
 * again, so it is no breakdown.
 */
function heldSegments(
  segments: ReadonlyArray<ContextWindowSegment>,
): ReadonlyArray<ContextWindowSegment> {
  const held = segments.filter(
    (segment) =>
      (segment.kind === "content" || segment.kind === "overhead") &&
      segment.tokens !== undefined &&
      segment.percent !== undefined,
  );
  return held.length === 1 && held[0]?.key === "used" ? [] : held;
}

/**
 * What a provider that is not planned by the host reports about its window: one
 * occupancy figure, and from some runtimes the parts of it. The thread's input
 * and output totals are sums over turns, not parts of that occupancy, so they
 * are never segments of it. The window's parts, and what holds the rest, come
 * from `providerWindowModel`, which also settles what the window holds when a
 * breakdown and the occupancy disagree, so the ring, the figure and the bar
 * always read the same number.
 */
export function reportedWindow(fallback: ComposerContextUsageFallback):
  | {
      readonly percent: number;
      readonly label: string;
      readonly total: string;
      readonly declared: boolean;
      readonly model: ProviderWindowModel;
      readonly usedTokens: number;
      readonly windowTokens: number;
    }
  | undefined {
  const window = fallback.contextWindow ?? fallback.modelContextWindow;
  if (window === undefined || fallback.contextTokens === undefined) return undefined;
  const model = providerWindowModel({
    breakdown: fallback.contextBreakdown,
    usedTokens: fallback.contextTokens,
    windowTokens: window,
  });
  const percent = Math.max(0, Math.min(100, (model.usedTokens / window) * 100));
  const share = `(${String(Math.round(percent))}%)`;
  return {
    percent,
    declared: fallback.contextWindow === undefined,
    label: `${compactTokens(model.usedTokens)} of ${compactTokens(window)} ${share}`,
    total: `${compactTokens(model.usedTokens)} / ${compactTokens(window)} ${share}`,
    model,
    usedTokens: model.usedTokens,
    windowTokens: window,
  };
}

export function compactTokens(tokens: number): string {
  return compactTokenCount(tokens);
}
