import type { ReactNode } from "react";

export interface EmptyThreadStartProps {
  /** The thread's own title; a thread without one is "Start this thread". */
  readonly title: string | undefined;
  /** The groups offered on the one surface: workspace presets and templates. */
  readonly children?: ReactNode;
}

/**
 * The empty thread's start block: a heading, one line of hint, and one quiet
 * surface holding whatever the host offers. It replaces a bare sentence and two
 * separate lifted cards, which read as unrelated boxes pasted onto the transcript.
 */
export function EmptyThreadStart(props: EmptyThreadStartProps) {
  const title = props.title?.trim();
  return (
    <div className="empty-start">
      <h2 className="empty-start__title">
        {title === undefined || title.length === 0 ? "Start this thread" : title}
      </h2>
      <p className="empty-start__hint">Send a prompt to begin, or set up the workspace first.</p>
      {/* Empty when the host offers nothing; the stylesheet hides it then. */}
      <div className="empty-start__surface">{props.children}</div>
    </div>
  );
}
