import { CANVAS_TOOL_NAME } from "./canvasAgentTools";

/**
 * Sent in a turn's required context whenever `octant_canvas` is offered.
 *
 * The same rule in the tool description did not steer a runtime that owns
 * file tools: asked for a memo in Work, it wrote a Markdown file, and after a
 * denial pasted the memo into the reply. Instructions reach the model where a
 * tool description does not. It names no provider and grants nothing.
 */
export const CANVAS_DELIVERY_INSTRUCTIONS =
  "Deliver a document, report, memo, plan, deck, dashboard, page, or prototype the person will keep or share as a Canvas with the octant_canvas tool, not as a file written with your own file tools and not as a long reply, unless the person asks for a file or for plain text. This instruction grants no tools or authority.";

/**
 * Sent in place of the Canvas rule when the person turned on delivering
 * documents with the runtime's own artifact tool (`toolName`), which publishes
 * to their account with the model's provider. The runtime may still leave the
 * tool out of a session, so the rule falls back to a Canvas, and a Canvas
 * stays the answer when the person asks for one. Like the Canvas rule it
 * grants nothing: the driver's gate decides every call.
 */
export function nativeArtifactDeliveryInstructions(input: {
  readonly toolName: string;
  readonly canvasOffered: boolean;
}): string {
  const fallback = input.canvasOffered
    ? ` When the person asks for a Canvas, or when the ${input.toolName} tool is not available to you, deliver it as a Canvas with the ${CANVAS_TOOL_NAME} tool instead.`
    : "";
  return `Deliver a document, report, memo, plan, deck, dashboard, page, or prototype the person will keep or share with your ${input.toolName} tool: write it as one .html or .md file in the working folder, then publish that file with ${input.toolName}, which puts it on the person's own account with this model's provider, outside this computer. Do not leave it only as a file or as a long reply unless the person asks for a file or for plain text.${fallback} This instruction grants no tools or authority.`;
}

/**
 * The delivery rule a turn carries: the artifact rule when the driver names
 * its artifact tool for this turn, otherwise the Canvas rule when Canvas is
 * offered, otherwise none.
 */
export function documentDeliveryInstructions(input: {
  readonly artifactToolName: string | undefined;
  readonly canvasOffered: boolean;
}): string | undefined {
  if (input.artifactToolName !== undefined) {
    return nativeArtifactDeliveryInstructions({
      toolName: input.artifactToolName,
      canvasOffered: input.canvasOffered,
    });
  }
  return input.canvasOffered ? CANVAS_DELIVERY_INSTRUCTIONS : undefined;
}

export function offersCanvasTool(
  definitions: ReadonlyArray<{ readonly name: string }> | undefined,
): boolean {
  return definitions?.some((definition) => definition.name === CANVAS_TOOL_NAME) === true;
}
