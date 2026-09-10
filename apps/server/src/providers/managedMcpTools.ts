import type { ProviderToolDefinition } from "@octant/provider-sdk/driver";
import type { ProviderToolImage } from "@octant/contracts/providers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface ManagedToolAnswer {
  readonly resultJson: string;
  readonly isError: boolean;
  readonly images?: ReadonlyArray<ProviderToolImage>;
}

export interface ManagedToolCallContext {
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** The transport supplies the caller; execution belongs to the app's tool policy. */
export function createManagedMcpTools(
  definitions: ReadonlyArray<ProviderToolDefinition>,
  execute: (
    name: string,
    inputJson: string,
    signal: AbortSignal,
    context?: ManagedToolCallContext,
  ) => Promise<ManagedToolAnswer>,
): { readonly kind: "ready"; readonly server: McpServer } | { readonly kind: "invalid" } {
  const tools: Tool[] = [];
  const names = new Set<string>();
  for (const definition of definitions) {
    const parsed = ToolSchema.safeParse(definition);
    if (!parsed.success || names.has(definition.name)) return { kind: "invalid" };
    names.add(definition.name);
    tools.push(parsed.data);
  }
  const server = new McpServer({ name: "octant", version: "1" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!names.has(request.params.name))
      return { content: [{ type: "text", text: '{"error":"tool-unavailable"}' }], isError: true };
    const metadata = request.params._meta;
    const inputJson = JSON.stringify(request.params.arguments ?? {});
    const answer =
      metadata === undefined
        ? await execute(request.params.name, inputJson, extra.signal)
        : await execute(request.params.name, inputJson, extra.signal, { metadata });
    return {
      content: [
        { type: "text", text: answer.resultJson },
        ...(answer.images ?? []).map((image) => ({ type: "image" as const, ...image })),
      ],
      isError: answer.isError,
    };
  });
  return { kind: "ready", server };
}
