import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type {
  CanvasCreateReceipt,
  CanvasThreadReferenceCard,
} from "@octant/contracts/canvas-cards";
import type { CanvasDocumentRecipe } from "@octant/contracts/canvas-skill";
import { useEffect, useRef, useState } from "react";
import {
  CreateCanvasDraft,
  type CanvasCreationContext,
  type CanvasRecipeFillRequest,
} from "./CreateCanvasDraft";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface CanvasCreatePanelProps {
  readonly client: CanvasClient;
  readonly context: CanvasCreationContext;
  readonly onCreated?: (receipt: CanvasCreateReceipt, card: CanvasThreadReferenceCard) => void;
  /** Present when a thread is attached whose agent can fill a recipe's skeleton. */
  readonly onAskAgentToFill?: (request: CanvasRecipeFillRequest) => Promise<boolean>;
}

export function CanvasCreatePanel(props: CanvasCreatePanelProps) {
  const [denial, setDenial] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<ReadonlyArray<CanvasDocumentRecipe>>([]);
  const createdCard = useRef<CanvasThreadReferenceCard | null>(null);
  const client = props.client;

  // A host without the recipe route, or one whose list fails to load, still
  // offers a blank Canvas; the chooser simply does not appear.
  useEffect(() => {
    if (client.recipes === undefined) return;
    let current = true;
    client.recipes().then(
      (catalog) => {
        if (current) setRecipes(catalog.recipes);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client]);

  return (
    <section aria-label="Create Canvas" data-testid="canvas-create-panel">
      <CreateCanvasDraft
        context={props.context}
        recipes={recipes}
        {...(props.onAskAgentToFill === undefined
          ? {}
          : { onAskAgentToFill: props.onAskAgentToFill })}
        onCreate={async (request) => {
          setDenial(null);
          const result = await client.create(request);
          if (result.kind === "denied") {
            setDenial(result.message);
            return null;
          }
          createdCard.current = result.card;
          return result.receipt;
        }}
        // Reported after any fill-in ask, because a caller may close this
        // panel on creation and the ask must not depend on it staying open.
        onSettled={(receipt) => {
          const card = createdCard.current;
          if (card !== null) props.onCreated?.(receipt, card);
        }}
      />
      {denial ? (
        <OctantAlert testId="canvas-create-panel-denial" tone="warning">
          {denial}
        </OctantAlert>
      ) : null}
    </section>
  );
}
