import type { OctantMode } from "@octant/contracts/modes";
import { Aperture, FolderPlus, Sparkles } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface AgentModeWelcomeProps {
  readonly mode: Extract<OctantMode, "work" | "code">;
  readonly onAddFolder: () => void;
  readonly onOpenDraft?: () => void;
  readonly providerReady: boolean;
  readonly providerMessage?: string;
}

const copy: Record<
  AgentModeWelcomeProps["mode"],
  { readonly eyebrow: string; readonly heading: string; readonly description: string }
> = {
  work: {
    eyebrow: "Work",
    heading: "Add a folder to start",
    description:
      "Bind a confined folder for documents, decks, spreadsheets, and artifacts. Then open a work thread from the harness composer.",
  },
  code: {
    eyebrow: "Code",
    heading: "Add a folder to start",
    description:
      "Bind a confined folder for approval-gated coding work. Then start a Code thread with provider, branch, and delivery context.",
  },
};

export function AgentModeWelcome(props: AgentModeWelcomeProps) {
  const presentation = copy[props.mode];
  return (
    <section
      aria-label={`${presentation.eyebrow} welcome`}
      className="draft-thread agent-mode-welcome"
    >
      <div className="draft-thread__canvas">
        <div className="draft-thread__welcome">
          <Aperture
            aria-hidden="true"
            className="new-thread-welcome__mark"
            size={24}
            strokeWidth={1.4}
          />
          <p className="draft-thread__eyebrow">Octant {presentation.eyebrow}</p>
          <h1 className="draft-thread__heading">{presentation.heading}</h1>
          <p className="draft-thread__description">{presentation.description}</p>
        </div>

        <div className="draft-thread__intent-cards" role="list" aria-label="Get started">
          <OctantButton
            className="draft-thread__intent-card"
            onClick={props.onAddFolder}
            role="listitem"
            type="button"
            variant="outline"
          >
            <span className="draft-thread__intent-label">
              <FolderPlus aria-hidden="true" size={14} strokeWidth={1.8} />
              Add folder
            </span>
            <span className="draft-thread__intent-description">
              Select a confined folder on this Mac.
            </span>
          </OctantButton>
          {props.onOpenDraft === undefined ? null : (
            <OctantButton
              className="draft-thread__intent-card"
              disabled={!props.providerReady}
              onClick={props.onOpenDraft}
              role="listitem"
              type="button"
              variant="outline"
            >
              <span className="draft-thread__intent-label">
                <Sparkles aria-hidden="true" size={14} strokeWidth={1.8} />
                Open harness
              </span>
              <span className="draft-thread__intent-description">
                Start a draft thread before the first folder is bound.
              </span>
            </OctantButton>
          )}
        </div>

        {props.providerMessage === undefined ? null : (
          <p className="draft-thread__error" role="status">
            {props.providerMessage}
          </p>
        )}
        {!props.providerReady ? (
          <p className="draft-thread__hint" role="status">
            Detecting local providers… connect Ollama or a CLI runtime in Settings if this takes
            longer than a few seconds.
          </p>
        ) : (
          <p className="draft-thread__hint">
            Tip: use the sidebar <strong>Add folder</strong> action any time.
          </p>
        )}
      </div>
    </section>
  );
}
