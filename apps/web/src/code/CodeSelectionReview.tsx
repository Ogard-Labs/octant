import { lazy, Suspense, useState } from "react";
import type { MonacoTextSelection } from "./MonacoEditorAdapter";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";

const Diff = lazy(() =>
  import("./MonacoDiffAdapter").then((module) => ({ default: module.MonacoDiffAdapter })),
);

export function selectionPrompt(path: string, selection: MonacoTextSelection): string {
  const longest = [...selection.text.matchAll(/`+/g)].reduce(
    (size, match) => Math.max(size, match[0].length),
    2,
  );
  const fence = "`".repeat(longest + 1);
  return `Suggest a replacement for the selected text in ${JSON.stringify(path)}, lines ${selection.range.startLineNumber}–${selection.range.endLineNumber}. Reply with the replacement in one fenced code block. Do not edit files; I will review the proposal in the editor.\n\n${fence}\n${selection.text}\n${fence}`;
}

export function singleCodeProposal(response: string): string | undefined {
  const blocks = [...response.matchAll(/^(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^\1[\t ]*$/gm)];
  if (blocks.length !== 1) return undefined;
  return blocks[0]?.[2]?.replace(/\r?\n$/, "");
}

/** Agent text can enter the draft only after an explicit comparison and current-text check. */
export function CodeSelectionReview(props: {
  readonly selection: MonacoTextSelection;
  readonly baseline: string;
  readonly currentText: string;
  readonly response?: string;
  readonly language: string;
  readonly modelUri: string;
  readonly readOnly: boolean;
  readonly onApply: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [proposal, setProposal] = useState("");
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState<string>();
  const stale = props.currentText !== props.baseline;
  return (
    <section className="code-editor-pane__references" aria-label="Review selection replacement">
      <p>
        Review a replacement for lines {props.selection.range.startLineNumber}–
        {props.selection.range.endLineNumber}. Applying changes the draft; Save writes the file.
      </p>
      <div className="editor-tools">
        <OctantButton
          size="sm"
          variant="ghost"
          disabled={props.response === undefined}
          onClick={() => {
            const text = singleCodeProposal(props.response ?? "");
            if (text === undefined)
              setNotice(
                "The latest response must contain exactly one fenced code block. Paste the replacement below instead.",
              );
            else {
              setProposal(text);
              setPreview(false);
              setNotice(undefined);
            }
          }}
        >
          Use latest agent response
        </OctantButton>
        <OctantButton size="sm" variant="ghost" onClick={props.onClose}>
          Close proposal
        </OctantButton>
      </div>
      <OctantTextarea
        aria-label="Proposed replacement"
        value={proposal}
        onChange={(event) => {
          setProposal(event.target.value);
          setPreview(false);
        }}
      />
      <OctantButton size="sm" variant="secondary" onClick={() => setPreview(true)}>
        Preview replacement
      </OctantButton>
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {stale ? (
        <p role="alert">
          The draft changed after this selection was sent. Select the current text again before
          applying.
        </p>
      ) : null}
      {!preview ? null : (
        <>
          <Suspense fallback={<p>Loading comparison…</p>}>
            <Diff
              ariaLabel="Selection replacement comparison"
              language={props.language}
              modelUriBase={`${props.modelUri}/selection-proposal`}
              original={props.selection.text}
              modified={proposal}
              renderSideBySide={false}
            />
          </Suspense>
          <OctantButton
            size="sm"
            variant="secondary"
            disabled={stale || props.readOnly}
            onClick={() => {
              if (props.currentText !== props.baseline) return;
              props.onApply(
                props.baseline.slice(0, props.selection.startOffset) +
                  proposal +
                  props.baseline.slice(props.selection.endOffset),
              );
            }}
          >
            Apply replacement to draft
          </OctantButton>
        </>
      )}
    </section>
  );
}
