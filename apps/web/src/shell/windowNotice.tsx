import { Component, createContext, type ReactNode } from "react";

/**
 * Says one sentence where this window's thread notices appear. Parts that load
 * on first use report a load failure through it.
 */
export const WindowNoticeContext = createContext<((sentence: string) => void) | undefined>(
  undefined,
);

/** The sentence for a part of the window that could not be loaded. */
export function couldNotLoad(what: string): string {
  return `Couldn't load ${what}. Reload the window to try again.`;
}

/**
 * Holds a part that loads on first use, such as a menu's items or the Undo
 * notice. If it cannot load or draw, it draws nothing in place and says so
 * where thread notices appear; the rest of the window stays usable. `asked`
 * counts the times the person asked for the part (a menu opened): each new
 * ask after a failure says so again, or a reopened menu would show nothing
 * and say nothing once the first notice was dismissed.
 */
export class LazyPartBoundary extends Component<
  { readonly children: ReactNode; readonly what: string; readonly asked?: number },
  { readonly failed: boolean }
> {
  static override contextType = WindowNoticeContext;
  declare context: React.ContextType<typeof WindowNoticeContext>;
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.context?.(couldNotLoad(this.props.what));
  }
  override componentDidUpdate(previous: { readonly asked?: number }) {
    if (this.state.failed && previous.asked !== this.props.asked) {
      this.context?.(couldNotLoad(this.props.what));
    }
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
