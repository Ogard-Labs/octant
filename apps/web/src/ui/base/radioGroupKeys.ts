import type { KeyboardEvent } from "react";

const STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Arrow-key movement for a `role="radiogroup"` built from `role="radio"`
 * buttons. A radio group is one place to arrive and the arrows move through it:
 * focus lands on the neighbour and selects it, wrapping past either end, and
 * Home and End jump to the ends. Put it on the group, not on the buttons, so
 * the choices stay ordinary buttons for pointer and assistive technology.
 */
export function moveWithinRadioGroup(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  ).filter((radio) => !radio.matches(':disabled, [aria-disabled="true"]'));
  const at = radios.findIndex((radio) => radio === document.activeElement);
  if (at === -1) return;
  const last = radios.length - 1;
  const step = STEP[event.key];
  let next: number | undefined;
  if (step !== undefined) next = (at + step + radios.length) % radios.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  const radio = next === undefined ? undefined : radios[next];
  if (radio === undefined) return;
  event.preventDefault();
  radio.focus();
  radio.click();
}
