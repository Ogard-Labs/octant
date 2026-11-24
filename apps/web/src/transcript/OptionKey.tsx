/**
 * The number that picks an option, shown at its trailing edge. Only the first
 * nine options have one, since only 1–9 pick. It is a hint for the eye: the
 * option is already named and reachable, so assistive technology skips it.
 */
export function OptionKey(props: { readonly index: number }) {
  if (props.index > 8) return null;
  return (
    <kbd aria-hidden="true" className="kbd provider-question-card__key">
      {props.index + 1}
    </kbd>
  );
}
