import { createElement, lazy, Suspense, type ComponentType } from "react";

/**
 * A component whose code and styles load when it is first drawn, with a plain
 * one standing in until then, and for good if they cannot load: a tab left open
 * across an update asks for a file the host no longer has, and thrown out of
 * render the failure would take the surface around it down.
 *
 * Awaited in a try rather than given a rejection handler: the window build
 * moves a `.then` on an import inside its own stylesheet wait, where the
 * handler never sees a stylesheet that failed.
 */
export function lazyOr<P extends object>(
  load: () => Promise<ComponentType<P>>,
  Plain: ComponentType<P>,
): ComponentType<P> {
  const Loaded = lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try {
      return { default: await load() };
    } catch {
      return { default: Plain };
    }
  }) as ComponentType<P>;
  return (props) =>
    createElement(
      Suspense,
      { fallback: createElement(Plain, props) },
      createElement(Loaded, props),
    );
}
