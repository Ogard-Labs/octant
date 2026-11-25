import type { ReactNode } from "react";

/** What swipes need above them; the browser stand-in has no swipes. */
export function GestureRoot(props: { readonly children: ReactNode }) {
  return props.children;
}
