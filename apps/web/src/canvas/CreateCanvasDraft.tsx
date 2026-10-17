import type {
  CanvasCreateRequest,
  CanvasCreateReceipt,
  CanvasOriginThreadId,
  CanvasWorkspaceScope,
} from "@octant/contracts/canvas-cards";
import type { CanvasSourceManifest } from "@octant/contracts/canvas";
import type { CanvasDocumentRecipe } from "@octant/contracts/canvas-skill";
import type { AgentRunAuthority } from "@octant/contracts/agent-run";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface CanvasCreationContext {
  readonly hostId: HostId;
  readonly mode: OctantMode;
  readonly workspace: CanvasWorkspaceScope;
  readonly originThreadId: CanvasOriginThreadId;
  readonly requestedAuthority: AgentRunAuthority;
  readonly sourceManifest: CanvasSourceManifest;
}

/** What the attached thread's agent is asked to fill, once the Canvas exists. */
export interface CanvasRecipeFillRequest {
  readonly receipt: CanvasCreateReceipt;
  readonly recipe: CanvasDocumentRecipe;
  /** What the person said the Canvas should cover; empty when they said nothing. */
  readonly notes: string;
}

export interface CreateCanvasDraftProps {
  readonly context: CanvasCreationContext;
  readonly onCreate: (request: CanvasCreateRequest) => Promise<CanvasCreateReceipt | null>;
  /** After a create succeeds and any fill-in ask has been made. */
  readonly onSettled?: (receipt: CanvasCreateReceipt) => void;
  /** The recipes this host offers. Absent or empty, the draft starts blank only. */
  readonly recipes?: ReadonlyArray<CanvasDocumentRecipe>;
  /**
   * Present only when a thread is attached whose agent can be asked. The ask
   * is an ordinary message on that thread, so the agent fills the Canvas with
   * the thread's own authority and nothing more.
   */
  readonly onAskAgentToFill?: (request: CanvasRecipeFillRequest) => Promise<boolean>;
}

const BLANK = "blank";

export function CreateCanvasDraft({
  context,
  onCreate,
  onSettled,
  recipes = [],
  onAskAgentToFill,
}: CreateCanvasDraftProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [startFrom, setStartFrom] = useState<string>(BLANK);
  const [askAgent, setAskAgent] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CanvasCreateReceipt | null>(null);
  const [fillOutcome, setFillOutcome] = useState<"asked" | "not-asked" | null>(null);
  const recipe = recipes.find((candidate) => String(candidate.id) === startFrom);
  const willAskAgent = recipe !== undefined && onAskAgentToFill !== undefined && askAgent;

  const handleSubmit = useCallback(async () => {
    setDenial(null);
    setReceipt(null);
    setFillOutcome(null);
    setBusy(true);
    try {
      const request: Record<string, unknown> = {
        schemaVersion: 1,
        kind: "canvas-create",
        requestId: crypto.randomUUID(),
        intent: recipe !== undefined ? "template" : prompt ? "prompt" : "blank",
        hostId: context.hostId,
        mode: context.mode,
        workspace: context.workspace,
        originThreadId: context.originThreadId,
        title: title.trim() || recipe?.title || "Untitled canvas",
        sourceManifest: context.sourceManifest,
        requestedAuthority: context.requestedAuthority,
      };
      if (recipe !== undefined) request.templateId = String(recipe.id);
      else if (prompt) request.prompt = prompt;
      const result = await onCreate(request as CanvasCreateRequest);
      if (!result) {
        setDenial("Canvas creation was denied.");
        return;
      }
      // The agent is asked only once the Canvas exists, so the message names
      // a Canvas it can read and revise rather than one that might not appear.
      if (willAskAgent) {
        let asked = false;
        try {
          asked = await onAskAgentToFill({ receipt: result, recipe, notes: notes.trim() });
        } catch {
          asked = false;
        }
        setFillOutcome(asked ? "asked" : "not-asked");
      }
      setReceipt(result);
      onSettled?.(result);
    } finally {
      setBusy(false);
    }
  }, [context, title, prompt, recipe, notes, willAskAgent, onAskAgentToFill, onCreate, onSettled]);

  if (receipt) {
    return (
      <div data-testid="canvas-create-success">
        <div data-testid="receipt-canvas-id">{String(receipt.canvasId)}</div>
        <div data-testid="receipt-status">{receipt.outcome}</div>
        {fillOutcome === null ? null : (
          <p className="canvas-start-from__note" role="status">
            {fillOutcome === "asked"
              ? "Asked this thread's agent to fill it in."
              : "The Canvas is ready, but the agent could not be asked. Ask in the thread."}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="canvas-revise-form"
      data-testid="canvas-create-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void handleSubmit();
      }}
    >
      {recipes.length === 0 ? null : (
        <StartFromChooser onChange={setStartFrom} recipes={recipes} value={startFrom} />
      )}
      <OctantInput
        aria-label="Title"
        className="input"
        data-testid="title-input"
        placeholder={recipe?.title ?? "Untitled canvas"}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {recipe === undefined ? (
        <OctantTextarea
          aria-label="Prompt"
          className="textarea"
          data-testid="prompt-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      ) : onAskAgentToFill === undefined ? (
        <p className="canvas-start-from__note">
          Opens with the recipe's sections, each marked with what belongs there.
        </p>
      ) : (
        <>
          <label className="canvas-start-from__ask check">
            <OctantCheckbox
              checked={askAgent}
              onChange={(event) => setAskAgent(event.target.checked)}
            />
            <span>Ask this thread's agent to fill it in</span>
          </label>
          {askAgent ? (
            <OctantTextarea
              aria-label="What should it cover?"
              className="textarea"
              data-testid="fill-notes-input"
              placeholder="What should it cover? (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          ) : (
            <p className="canvas-start-from__note">
              Opens with the recipe's sections, each marked with what belongs there.
            </p>
          )}
        </>
      )}
      {denial ? (
        <div className="field-error" data-testid="denial-message">
          {denial}
        </div>
      ) : null}
      <OctantButton data-testid="create-button" disabled={busy} size="sm" type="submit">
        {willAskAgent ? "Create and ask agent" : "Create Canvas"}
      </OctantButton>
    </form>
  );
}

interface StartFromOption {
  readonly value: string;
  readonly title: string;
  readonly description: string;
  readonly skeleton: CanvasDocumentRecipe["skeleton"] | readonly [];
}

/**
 * Where a new Canvas starts: blank, or one of the host's recipes.
 *
 * A radio group with one tab stop. Arrow keys, Home, and End move the choice
 * and the focus together, as a native radio group does. Each option's name is
 * its title and its description the one-line summary, so a screen reader
 * hears what a recipe holds without the visual preview.
 */
function StartFromChooser(props: {
  readonly recipes: ReadonlyArray<CanvasDocumentRecipe>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const labelId = useId();
  const descriptionPrefix = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const options: ReadonlyArray<StartFromOption> = [
    { value: BLANK, title: "Blank", description: "An empty Canvas with its title.", skeleton: [] },
    ...props.recipes.map((recipe) => ({
      value: String(recipe.id),
      title: recipe.title,
      description: recipe.summary ?? recipe.whenToUse,
      skeleton: recipe.skeleton,
    })),
  ];
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === props.value),
  );

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = selectedIndex === last ? 0 : selectedIndex + 1;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = selectedIndex === 0 ? last : selectedIndex - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    }
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || option === undefined) return;
    event.preventDefault();
    props.onChange(option.value);
    optionRefs.current[next]?.focus();
  };

  return (
    <div className="canvas-start-from">
      <p className="canvas-start-from__label" id={labelId}>
        Start from
      </p>
      <div
        aria-labelledby={labelId}
        className="canvas-start-from__options"
        onKeyDown={move}
        role="radiogroup"
      >
        {options.map((option, index) => {
          const checked = index === selectedIndex;
          const descriptionId = `${descriptionPrefix}-${index}`;
          return (
            <OctantButton
              aria-checked={checked}
              aria-describedby={descriptionId}
              aria-label={option.title}
              className="canvas-start-from__option"
              key={option.value}
              onClick={() => props.onChange(option.value)}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              role="radio"
              tabIndex={checked ? 0 : -1}
              type="button"
              variant="bare"
            >
              <SkeletonPreview skeleton={option.skeleton} />
              <span className="canvas-start-from__text">
                <span className="canvas-start-from__title">{option.title}</span>
                <span className="canvas-start-from__summary" id={descriptionId}>
                  {option.description}
                </span>
              </span>
            </OctantButton>
          );
        })}
      </div>
    </div>
  );
}

/** A miniature of a recipe's sections; a heading draws as a short, darker bar. */
function SkeletonPreview(props: { readonly skeleton: StartFromOption["skeleton"] }) {
  return (
    <span aria-hidden="true" className="canvas-start-from__preview">
      {props.skeleton.map((block, index) => (
        <span
          className="canvas-start-from__preview-row"
          data-kind={block.kind === "heading" ? "heading" : "block"}
          key={`${String(index)}-${block.kind}`}
        />
      ))}
    </span>
  );
}
