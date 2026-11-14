export type GuidedTourPictureId = "new-thread" | "projects" | "tools" | "composer" | "settings";

export interface GuidedTourStep {
  readonly id: GuidedTourPictureId;
  /** Said after "n of m" in the card's label. */
  readonly topic: string;
  readonly title: string;
  readonly body: string;
  /**
   * Where the real control is, tried in order. The first match that is drawn
   * on screen wins; a step with no match is skipped rather than pointing at
   * nothing.
   */
  readonly targets: ReadonlyArray<string>;
  /** Where the card prefers to sit beside the control, tried in order. */
  readonly sides: ReadonlyArray<"right" | "below" | "above" | "left">;
  /**
   * Beside a control, where the card's edge lines up with it: "start" puts the
   * card's top level with the ring, for a control at the top of a tall column;
   * the default centres the card on the control.
   */
  readonly align?: "start" | "center";
}

/** How far the ring stands off the control it surrounds. */
export const TOUR_RING_PAD = 4;

export const GUIDED_TOUR_STEPS: ReadonlyArray<GuidedTourStep> = [
  {
    id: "new-thread",
    topic: "New thread",
    title: "Start work in a new thread",
    body: "New chat or New task opens a thread in Chat, Work or Code. Pick the agent and model before you send.",
    targets: ['button[aria-label="New chat"]', 'button[aria-label="New task"]'],
    sides: ["below", "right"],
  },
  {
    id: "projects",
    topic: "Projects",
    title: "Projects keep work together",
    body: "Each Project holds its threads, files and settings in one place.",
    // The row of controls at the top of the Projects list, not the whole
    // panel, which is as tall as the window and leaves nothing to point at.
    targets: [
      'nav[aria-label="Projects"] > .project-nav__toolbar',
      'nav[aria-label="Projects"] h2',
      'button[aria-label="Projects"]',
    ],
    sides: ["right", "below"],
    align: "start",
  },
  {
    id: "tools",
    topic: "Tools",
    title: "Tools open beside the thread",
    body: "Environment, Terminal, Review, Browser and Files open next to the thread you are in.",
    targets: ['[role="toolbar"][aria-label="Tools"]'],
    sides: ["below", "left"],
  },
  {
    id: "composer",
    topic: "Composer",
    title: "Say what you need",
    body: "Attach files, choose the mode, and see what the agent may do before it does it.",
    targets: [".composer"],
    sides: ["above", "left"],
  },
  {
    id: "settings",
    topic: "Settings",
    title: "Make Octant yours",
    body: "Settings holds providers, look and feel, and permissions.",
    targets: ['button[aria-label="Settings"]', '[aria-label^="Account menu"]'],
    sides: ["right", "above"],
  },
];

function isDrawn(element: Element): boolean {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < globalThis.innerHeight &&
    rect.left < globalThis.innerWidth
  );
}

/** The control a step points at, or nothing when it is not on screen. */
export function findTourTarget(step: GuidedTourStep): HTMLElement | undefined {
  for (const selector of step.targets) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (isDrawn(element)) return element;
    }
  }
  return undefined;
}

export interface TourPlacementRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TourCardPlacement {
  readonly left: number;
  readonly top: number;
}

const GAP = 14;
const MARGIN = 12;

function overlaps(
  card: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  other: TourPlacementRect,
): boolean {
  return (
    card.left < other.left + other.width &&
    card.left + card.width > other.left &&
    card.top < other.top + other.height &&
    card.top + card.height > other.top
  );
}

/**
 * Puts the card beside the control on the first preferred side where it fits
 * whole, centred on the control along the other axis and kept inside the
 * window. The card never covers the control (with its ring) or any rectangle
 * in `avoid`, text the tour must leave readable: a card that would is slid
 * along its side until it clears, and a side where nothing clears is passed
 * over. When no side fits it takes the one with the most room.
 */
export function placeTourCard(
  target: TourPlacementRect,
  card: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  sides: GuidedTourStep["sides"],
  align: NonNullable<GuidedTourStep["align"]> = "center",
  avoid: ReadonlyArray<TourPlacementRect> = [],
): TourCardPlacement {
  const sideTop =
    align === "start"
      ? target.top - TOUR_RING_PAD
      : target.top + target.height / 2 - card.height / 2;
  const clampX = (value: number) =>
    Math.max(MARGIN, Math.min(value, viewport.width - card.width - MARGIN));
  const clampY = (value: number) =>
    Math.max(MARGIN, Math.min(value, viewport.height - card.height - MARGIN));
  const options = {
    right: {
      room: viewport.width - (target.left + target.width) - GAP - MARGIN - card.width,
      at: () => ({
        left: target.left + target.width + GAP,
        top: clampY(sideTop),
      }),
    },
    left: {
      room: target.left - GAP - MARGIN - card.width,
      at: () => ({
        left: target.left - GAP - card.width,
        top: clampY(sideTop),
      }),
    },
    below: {
      room: viewport.height - (target.top + target.height) - GAP - MARGIN - card.height,
      at: () => ({
        left: clampX(target.left + target.width / 2 - card.width / 2),
        top: target.top + target.height + GAP,
      }),
    },
    above: {
      room: target.top - GAP - MARGIN - card.height,
      at: () => ({
        left: clampX(target.left + target.width / 2 - card.width / 2),
        top: target.top - GAP - card.height,
      }),
    },
  } as const;
  const keepClear: ReadonlyArray<TourPlacementRect> = [
    {
      left: target.left - TOUR_RING_PAD,
      top: target.top - TOUR_RING_PAD,
      width: target.width + 2 * TOUR_RING_PAD,
      height: target.height + 2 * TOUR_RING_PAD,
    },
    ...avoid,
  ];
  const cleared = (spot: TourCardPlacement) =>
    keepClear.every((other) => !overlaps({ ...spot, ...card }, other));
  // Slides a spot along its side's free axis to the nearest place that clears
  // everything: tucked just above or just below each rectangle in the way.
  const slide = (side: keyof typeof options, spot: TourCardPlacement) => {
    if (cleared(spot)) return spot;
    const vertical = side === "right" || side === "left";
    const candidates = keepClear.flatMap((other) =>
      vertical
        ? [
            { left: spot.left, top: clampY(other.top - GAP - card.height) },
            { left: spot.left, top: clampY(other.top + other.height + GAP) },
          ]
        : [
            { left: clampX(other.left - GAP - card.width), top: spot.top },
            { left: clampX(other.left + other.width + GAP), top: spot.top },
          ],
    );
    const distance = (candidate: TourCardPlacement) =>
      Math.abs(candidate.left - spot.left) + Math.abs(candidate.top - spot.top);
    return candidates
      .filter(cleared)
      .sort((first, second) => distance(first) - distance(second))[0];
  };
  const place = (side: keyof typeof options) => {
    const spot = options[side].at();
    return slide(side, { left: clampX(spot.left), top: clampY(spot.top) });
  };
  const fitting = sides.find((side) => options[side].room >= 0 && place(side) !== undefined);
  if (fitting !== undefined) {
    const spot = place(fitting);
    if (spot !== undefined) return spot;
  }
  const roomiest = sides.reduce((best, side) =>
    options[side].room > options[best].room ? side : best,
  );
  return (
    place(roomiest) ?? {
      left: clampX(options[roomiest].at().left),
      top: clampY(options[roomiest].at().top),
    }
  );
}
