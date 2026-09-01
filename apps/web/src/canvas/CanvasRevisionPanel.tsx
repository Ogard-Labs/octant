import type {
  CanvasReviseRequest,
  CanvasVersionHistoryEntry,
} from "@octant/contracts/canvas-revision";
import { useCallback, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface ReviseCanvasDraftProps {
  readonly expectedSequence: number;
  readonly requestBase: Omit<
    CanvasReviseRequest,
    "schemaVersion" | "kind" | "requestId" | "expectedSequence" | "prompt"
  >;
  readonly onRevise: (request: CanvasReviseRequest) => Promise<boolean>;
}

export function ReviseCanvasDraft(props: ReviseCanvasDraftProps) {
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (prompt.trim().length === 0) {
      setMessage("Enter a refinement prompt.");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    const request: CanvasReviseRequest = {
      schemaVersion: 1,
      kind: "canvas-revise",
      requestId: crypto.randomUUID() as CanvasReviseRequest["requestId"],
      expectedSequence: props.expectedSequence,
      prompt: prompt.trim(),
      ...props.requestBase,
    };
    const accepted = await props.onRevise(request);
    setSubmitting(false);
    if (accepted) {
      setPrompt("");
      setMessage("Revision saved.");
      return;
    }
    setMessage("Canvas revision was denied.");
  }, [prompt, props]);

  return (
    <form
      className="canvas-revise-form"
      data-testid="canvas-revise-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <label className="canvas-revise-form__label" htmlFor="canvas-revise-prompt">
        Refine canvas
      </label>
      <OctantTextarea
        id="canvas-revise-prompt"
        aria-label="Revision prompt"
        className="textarea"
        data-testid="canvas-revise-prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={3}
      />
      <OctantButton
        type="submit"
        data-testid="canvas-revise-submit"
        disabled={submitting}
        size="sm"
        variant="secondary"
      >
        Revise
      </OctantButton>
      {message ? <div data-testid="canvas-revise-message">{message}</div> : null}
    </form>
  );
}

export interface CanvasVersionHistoryPanelProps {
  readonly entries: ReadonlyArray<CanvasVersionHistoryEntry>;
  readonly selectedVersionId: string;
  readonly currentVersionId: string;
  readonly onSelect: (versionId: string) => void;
}

export function CanvasVersionHistoryPanel(props: CanvasVersionHistoryPanelProps) {
  return (
    <section className="canvas-version-history" aria-label="Canvas version history">
      <h2 className="canvas-version-history__title">Version history</h2>
      <ol className="canvas-version-history__list" data-testid="canvas-version-history">
        {props.entries.map((entry) => {
          const isCurrent = String(entry.versionId) === String(props.currentVersionId);
          const isSelected = String(entry.versionId) === String(props.selectedVersionId);
          return (
            <li key={String(entry.versionId)}>
              <OctantButton
                type="button"
                className="canvas-version-history__item"
                data-testid={`canvas-version-${entry.sequence}`}
                aria-current={isSelected ? "true" : undefined}
                onClick={() => props.onSelect(String(entry.versionId))}
                variant="ghost"
              >
                <span className="canvas-version-history__sequence">v{entry.sequence}</span>
                <span className="canvas-version-history__label">
                  {entry.title}
                  {isCurrent ? " (current)" : ""}
                </span>
                {entry.promptSummary ? (
                  <span className="canvas-version-history__summary">{entry.promptSummary}</span>
                ) : null}
              </OctantButton>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
