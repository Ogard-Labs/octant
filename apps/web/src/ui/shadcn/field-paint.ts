/*
 * The paint every text field, text area and select shares: rest, hover and
 * keyboard focus. Defining it here, once, is what keeps a text area from
 * reacting differently from a single-line input; a recipe adds its own height
 * and padding, and a feature never repaints it.
 *
 * The border at rest is the strong one, so an edge is never guessed. Hover
 * steps it to the muted text colour, which is stronger than the rest edge in
 * both modes, and keyboard focus fills the field with the control hover tone.
 */
export const fieldPaint =
  "rounded-lg border border-input bg-transparent hover:border-muted-foreground focus-visible:bg-accent";
