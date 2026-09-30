import { useId } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import type { BundledWhatsNewView } from "../shell/hostBridge";

export interface WhatsNewDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly document: BundledWhatsNewView | undefined;
}

/**
 * Local notes for the running build. Never a network fetch — a missing
 * document is an empty state.
 */
export function WhatsNewDialog(props: WhatsNewDialogProps) {
  const titleId = useId();
  return (
    <OctantDialog
      className="whats-new__dialog"
      label="What's new"
      labelledBy={titleId}
      onClose={props.onClose}
      open={props.open}
    >
      <h2 className="h4" id={titleId}>
        What's new
      </h2>
      {props.document === undefined ? (
        <p className="whats-new__empty" role="status">
          Loading…
        </p>
      ) : props.document.kind === "empty" ? (
        <p className="whats-new__empty" role="status">
          There are no notes for this build.
        </p>
      ) : (
        <>
          <p className="whats-new__version">Octant {props.document.version}</p>
          <div className="whats-new__body">
            {whatsNewParagraphs(props.document.text).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </>
      )}
      <OctantButton onClick={props.onClose} type="button" variant="secondary">
        Close
      </OctantButton>
    </OctantDialog>
  );
}

/**
 * The bundled notes are plain text wrapped at a fixed column, so rendering
 * them preformatted broke sentences mid-line ("Updates are signed,\nand").
 * Blank lines separate paragraphs; a line starting with a list marker keeps
 * its own line.
 */
export function whatsNewParagraphs(text: string): ReadonlyArray<string> {
  return text
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .reduce((joined, line) => {
          if (joined.length === 0) return line;
          return /^[-*•] /.test(line) ? `${joined}\n${line}` : `${joined} ${line}`;
        }, ""),
    )
    .filter((paragraph) => paragraph.length > 0);
}
