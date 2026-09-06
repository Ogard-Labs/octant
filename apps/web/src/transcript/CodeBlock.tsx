import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface CodeBlockProps {
  readonly code: string;
  /** The fence's language tag, when the author gave one. */
  readonly language?: string | undefined;
}

type CopyState = "idle" | "copied" | "refused";

/** How long the control reports the outcome before it offers to copy again. */
const COPY_RECEIPT_MS = 1600;

/**
 * A fenced code block in a reply, the same in Chat, Work, and Code: a header
 * strip naming the language with a copy control at its end, then the code.
 * Copying is reported honestly — a host with no clipboard says so instead of
 * claiming the text was taken.
 */
export function CodeBlock(props: CodeBlockProps) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), COPY_RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <div className="code-block">
      <div className="code-block__header">
        {props.language === undefined ? null : (
          <span className="code-block__language">{props.language}</span>
        )}
        <OctantButton
          aria-label="Copy code"
          className="code-block__copy"
          onClick={() => {
            void copyToClipboard(props.code).then((copied) =>
              setState(copied ? "copied" : "refused"),
            );
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {state === "copied" ? (
            <Check aria-hidden="true" className="size-3" strokeWidth={2} />
          ) : (
            <Copy aria-hidden="true" className="size-3" strokeWidth={1.8} />
          )}
          <span>{copyLabel(state)}</span>
        </OctantButton>
      </div>
      <pre className="code-block__pre">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

function copyLabel(state: CopyState): string {
  switch (state) {
    case "idle":
      return "Copy";
    case "copied":
      return "Copied";
    case "refused":
      return "Not copied";
  }
}

async function copyToClipboard(value: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
