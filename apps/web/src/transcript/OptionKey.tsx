/**
 * The number that picks an option, after its label. Only the first nine
 * options have one, since only 1–9 pick. It is a hint for the eye: the option
 * is already named and reachable, so assistive technology skips it. It wears
 * the shared key chip the tooltips use, so it adds no stylesheet of its own to
 * the window's first load, which carries the question cards.
 */
export function OptionKey(props: { readonly index: number }) {
  if (props.index > 8) return null;
  return (
    <kbd aria-hidden="true" className="octant-tooltip__key">
      {props.index + 1}
    </kbd>
  );
}
