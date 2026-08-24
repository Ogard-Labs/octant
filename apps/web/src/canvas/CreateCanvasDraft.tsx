import type {
  CanvasCreateRequest,
  CanvasCreateReceipt,
  CanvasOriginThreadId,
  CanvasWorkspaceScope,
} from "@octant/contracts/canvas-cards";
import type { CanvasSourceManifest } from "@octant/contracts/canvas";
import type { AgentRunAuthority } from "@octant/contracts/agent-run";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import { useCallback, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
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

export interface CreateCanvasDraftProps {
  readonly context: CanvasCreationContext;
  readonly onCreate: (request: CanvasCreateRequest) => Promise<CanvasCreateReceipt | null>;
}

export function CreateCanvasDraft({ context, onCreate }: CreateCanvasDraftProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [denial, setDenial] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CanvasCreateReceipt | null>(null);

  const handleSubmit = useCallback(async () => {
    setDenial(null);
    setReceipt(null);
    const request: Record<string, unknown> = {
      schemaVersion: 1,
      kind: "canvas-create",
      requestId: crypto.randomUUID(),
      intent: prompt ? "prompt" : "blank",
      hostId: context.hostId,
      mode: context.mode,
      workspace: context.workspace,
      originThreadId: context.originThreadId,
      title: title || "Untitled canvas",
      sourceManifest: context.sourceManifest,
      requestedAuthority: context.requestedAuthority,
    };
    if (prompt) request.prompt = prompt;
    const result = await onCreate(request as CanvasCreateRequest);
    if (result) {
      setReceipt(result);
    } else {
      setDenial("Canvas creation was denied.");
    }
  }, [context, title, prompt, onCreate]);

  if (receipt) {
    return (
      <div data-testid="canvas-create-success">
        <div data-testid="receipt-canvas-id">{String(receipt.canvasId)}</div>
        <div data-testid="receipt-status">{receipt.outcome}</div>
      </div>
    );
  }

  return (
    <form
      className="canvas-revise-form"
      data-testid="canvas-create-form"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <OctantInput
        aria-label="Title"
        className="input"
        data-testid="title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <OctantTextarea
        aria-label="Prompt"
        className="textarea"
        data-testid="prompt-input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      {denial ? (
        <div className="field-error" data-testid="denial-message">
          {denial}
        </div>
      ) : null}
      <OctantButton type="submit" data-testid="create-button" size="sm">
        Create Canvas
      </OctantButton>
    </form>
  );
}
