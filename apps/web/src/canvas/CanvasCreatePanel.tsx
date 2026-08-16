import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type {
  CanvasCreateReceipt,
  CanvasThreadReferenceCard,
} from "@octant/contracts/canvas-cards";
import { useState } from "react";
import { CreateCanvasDraft, type CanvasCreationContext } from "./CreateCanvasDraft";

export interface CanvasCreatePanelProps {
  readonly client: CanvasClient;
  readonly context: CanvasCreationContext;
  readonly onCreated?: (receipt: CanvasCreateReceipt, card: CanvasThreadReferenceCard) => void;
}

export function CanvasCreatePanel(props: CanvasCreatePanelProps) {
  const [denial, setDenial] = useState<string | null>(null);
  return (
    <section aria-label="Create Canvas" data-testid="canvas-create-panel">
      <CreateCanvasDraft
        context={props.context}
        onCreate={async (request) => {
          setDenial(null);
          const result = await props.client.create(request);
          if (result.kind === "denied") {
            setDenial(result.message);
            return null;
          }
          props.onCreated?.(result.receipt, result.card);
          return result.receipt;
        }}
      />
      {denial ? (
        <p data-testid="canvas-create-panel-denial" role="alert">
          {denial}
        </p>
      ) : null}
    </section>
  );
}
