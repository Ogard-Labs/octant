import type { FirstRunOnboardingStatus } from "@octant/contracts/shell";
import { useEffect, useSyncExternalStore } from "react";
import { lazyOr } from "../lib/lazyOr";
import {
  closeGuidedTour,
  isGuidedTourOpen,
  markGuidedTourDue,
  openGuidedTour,
  readGuidedTourRecord,
  subscribeGuidedTour,
} from "./guidedTourState";
import { ANSWER_SURFACES, resolveSteps } from "./guidedTourSteps";

// Seen once per install, so the card stays out of the first bundle; the offer
// above it is all the window needs at start.
const GuidedTourSurface = lazyOr<object>(
  async () => (await import("./GuidedTourSurface")).GuidedTourSurface,
  () => null,
);

export interface GuidedTourProps {
  /** Host state. `undefined` until it arrives, which keeps the tour away. */
  readonly firstRunStatus: FirstRunOnboardingStatus | undefined;
  /**
   * Another surface owns the window: Settings, a dialog the shell opened, or a
   * thread that needs an answer. The tour neither starts nor stays over it.
   */
  readonly blocked: boolean;
}

/** How often a tour that is owed checks whether the window has gone quiet. */
const OFFER_CHECK_MS = 400;

/**
 * The first-start tour. It is offered once, after first-run setup has been
 * answered in this installation and nothing else needs the person; the menu
 * opens it again any time. The offer is withheld, not skipped, while a dialog,
 * Settings or a waiting thread is up: it comes when the window is quiet.
 */
export function GuidedTour(props: GuidedTourProps) {
  const open = useSyncExternalStore(subscribeGuidedTour, isGuidedTourOpen);
  const { firstRunStatus, blocked } = props;

  useEffect(() => {
    if (firstRunStatus === "pending") markGuidedTourDue();
  }, [firstRunStatus]);

  const owed =
    (firstRunStatus === "completed" || firstRunStatus === "skipped") &&
    readGuidedTourRecord() === "due";
  useEffect(() => {
    if (!owed || open || blocked) return;
    const offer = () => {
      if (readGuidedTourRecord() !== "due") return;
      if (document.querySelector(ANSWER_SURFACES) !== null) return;
      if (resolveSteps().length === 0) return;
      openGuidedTour();
    };
    offer();
    const timer = setInterval(offer, OFFER_CHECK_MS);
    return () => clearInterval(timer);
  }, [blocked, open, owed]);

  // A surface that needs the person takes the window over the tour.
  useEffect(() => {
    if (open && blocked) closeGuidedTour();
  }, [blocked, open]);

  return open ? <GuidedTourSurface /> : null;
}
