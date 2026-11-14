import type { FirstRunOnboardingStatus } from "@octant/contracts/shell";
import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { SIDEBAR_ACCOUNT_TRIGGER_SELECTOR } from "../shell/SidebarProfile";
import { IconButton } from "../shell/IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { GuidedTourPicture } from "./GuidedTourPicture";
import {
  closeGuidedTour,
  isGuidedTourOpen,
  markGuidedTourDue,
  openGuidedTour,
  readGuidedTourRecord,
  subscribeGuidedTour,
} from "./guidedTourState";
import {
  findTourTarget,
  GUIDED_TOUR_STEPS,
  placeTourCard,
  TOUR_RING_PAD,
  type GuidedTourStep,
} from "./guidedTourSteps";
import "./guided-tour.css";

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

/** Anything a person has to answer or has just opened, which the tour never covers. */
const ANSWER_SURFACES =
  '[role="dialog"]:not([data-octant-guided-tour]), [role="alertdialog"], [role="menu"], [role="listbox"]';
const MODAL_SURFACES = '[role="dialog"]:not([data-octant-guided-tour]), [role="alertdialog"]';

/** Arrow keys belong to these when focus is in one of them. */
const ARROW_KEY_CONTROLS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='spinbutton'], [role='listbox'], [role='tablist'], [role='menu']";

interface ResolvedStep {
  readonly step: GuidedTourStep;
  /** Its place in the full list, so "from here on" survives a step dropping out. */
  readonly order: number;
  readonly element: HTMLElement;
}

function resolveSteps(): ReadonlyArray<ResolvedStep> {
  const resolved: ResolvedStep[] = [];
  GUIDED_TOUR_STEPS.forEach((step, order) => {
    const element = findTourTarget(step);
    if (element !== undefined) resolved.push({ step, order, element });
  });
  return resolved;
}

function sameSteps(a: ReadonlyArray<ResolvedStep>, b: ReadonlyArray<ResolvedStep>): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return other !== undefined && other.order === entry.order && other.element === entry.element;
    })
  );
}

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

function GuidedTourSurface() {
  const titleId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [steps, setSteps] = useState(resolveSteps);
  const [from, setFrom] = useState(0);
  const [rect, setRect] = useState<DOMRect>();
  const [placement, setPlacement] = useState<{ left: number; top: number }>();

  const active = steps.find((entry) => entry.order >= from) ?? steps[steps.length - 1];
  const position = active === undefined ? -1 : steps.indexOf(active);
  const previous = position > 0 ? steps[position - 1] : undefined;
  const following = position >= 0 ? steps[position + 1] : undefined;
  const isLast = following === undefined;
  const activeElement = active?.element;

  const back = () => {
    if (previous !== undefined) setFrom(previous.order);
  };
  const forward = () => {
    if (following === undefined) closeGuidedTour();
    else setFrom(following.order);
  };

  // Keeps what is drawn true to the window: which controls are on screen
  // (a step whose control left drops out) and where the active one sits.
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const resolved = resolveSteps();
      setSteps((current) => (sameSteps(current, resolved) ? current : resolved));
      const current =
        resolved.find((entry) => entry.order >= from) ?? resolved[resolved.length - 1];
      const measured = current?.element.getBoundingClientRect();
      setRect((before) =>
        before !== undefined &&
        measured !== undefined &&
        before.left === measured.left &&
        before.top === measured.top &&
        before.width === measured.width &&
        before.height === measured.height
          ? before
          : measured,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(sync);
    };
    sync();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    const sizes = new ResizeObserver(schedule);
    if (activeElement !== undefined) sizes.observe(activeElement);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      mutations.disconnect();
      sizes.disconnect();
    };
  }, [activeElement, from]);

  // Nothing left to point at: end the tour instead of showing an empty card.
  useEffect(() => {
    if (steps.length === 0) closeGuidedTour();
  }, [steps.length]);

  // Focus moves into the card and comes back to where it was.
  const focusedIn = useRef(false);
  const placed = placement !== undefined;
  useEffect(() => {
    // The card is hidden until it is placed, and a hidden control cannot take focus.
    if (!placed || focusedIn.current) return;
    focusedIn.current = true;
    next.current?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => {
    const before = document.activeElement;
    return () => {
      const target =
        before instanceof HTMLElement && before.isConnected && before !== document.body
          ? before
          : document.querySelector<HTMLElement>(SIDEBAR_ACCOUNT_TRIGGER_SELECTOR);
      target?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const element = card.current;
    if (element === null || active === undefined || rect === undefined) return;
    const spot = placeTourCard(
      rect,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      active.step.sides,
      active.step.align,
    );
    setPlacement((before) =>
      before !== undefined && before.left === spot.left && before.top === spot.top ? before : spot,
    );
  }, [active, rect]);

  // Escape closes and the arrows move, wherever focus is, unless a surface the
  // person opened beside the tour (a menu) or a field owns the key.
  const stateRef = useRef({ back, forward });
  stateRef.current = { back, forward };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : document.body;
      if (document.querySelector(ANSWER_SURFACES) !== null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeGuidedTour();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (target.closest(ARROW_KEY_CONTROLS) !== null) return;
      if (card.current?.contains(target) !== true && target !== document.body) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") stateRef.current.back();
      else stateRef.current.forward();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // A modal that opens over the tour (a permission prompt) takes the window.
  useEffect(() => {
    const check = () => {
      if (document.querySelector(MODAL_SURFACES) !== null) closeGuidedTour();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (active === undefined) return null;
  const { step } = active;
  const ring = ringStyle(rect, active.element);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const controls = [
      ...(card.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []),
    ];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="guided-tour" data-octant-guided-tour-root>
      {ring === undefined ? null : (
        <div aria-hidden="true" className="guided-tour__ring" style={ring} />
      )}
      {/* ui-boundary-exception: non-modal-panel */}
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="false"
        className="guided-tour__card"
        data-octant-guided-tour
        onKeyDown={trapTab}
        ref={card}
        role="dialog"
        style={
          placement === undefined
            ? { visibility: "hidden" }
            : { left: placement.left, top: placement.top }
        }
      >
        <div className="guided-tour__picture" key={step.id}>
          <GuidedTourPicture id={step.id} />
        </div>
        <IconButton
          className="guided-tour__close"
          icon={X}
          label="Close tour"
          onClick={closeGuidedTour}
        />
        <div className="guided-tour__copy" key={`${step.id}-copy`}>
          <p className="guided-tour__label">
            {position + 1} of {steps.length} · {step.topic}
          </p>
          <h2 className="guided-tour__title" id={titleId}>
            {step.title}
          </h2>
          <p className="guided-tour__body" id={bodyId}>
            {step.body}
          </p>
        </div>
        <div className="guided-tour__foot">
          <ol aria-hidden="true" className="guided-tour__dots">
            {steps.map((entry) => (
              <li
                className="guided-tour__dot"
                data-active={entry === active ? "true" : undefined}
                key={entry.step.id}
              />
            ))}
          </ol>
          <div className="guided-tour__actions">
            {previous === undefined ? null : (
              <OctantButton onClick={back} size="sm" type="button" variant="ghost">
                Back
              </OctantButton>
            )}
            <OctantButton onClick={forward} ref={next} size="sm" type="button">
              {isLast ? "Done" : "Next"}
            </OctantButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function ringStyle(
  rect: DOMRect | undefined,
  element: HTMLElement,
): { left: number; top: number; width: number; height: number; borderRadius: number } | undefined {
  if (rect === undefined) return undefined;
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
  const pad = TOUR_RING_PAD;
  return {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
    borderRadius: Math.max(8, (Number.isFinite(radius) ? radius : 0) + pad),
  };
}
