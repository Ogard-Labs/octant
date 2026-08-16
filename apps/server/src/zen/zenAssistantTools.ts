import {
  decodeZenAssistantAppearanceInput,
  decodeZenAssistantAttachThreadInput,
  decodeZenAssistantCreateWidgetInput,
  decodeZenAssistantListWidgetsInput,
  decodeZenAssistantPlacementInput,
  decodeZenAssistantPreviewRecipeInput,
  decodeZenAssistantSearchThreadsInput,
  decodeZenAssistantToolResult,
  DEFAULT_ZEN_TIMER_DURATION_MS,
  MAX_ZEN_TIMER_DURATION_MS,
  ZenError,
  type ChatThread,
  type ProviderToolDefinition,
  type WindowId,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../chat/chatTurnRunner";
import type { ZenService } from "./zenService";

export interface ZenAssistantToolsDependencies {
  readonly zenService: Pick<
    ZenService,
    | "isAssistantThread"
    | "searchThreads"
    | "attachThread"
    | "bootstrap"
    | "handleCommand"
    | "applyAssistantPlacement"
    | "applyAssistantAppearance"
    | "createTimerWidget"
    | "previewRecipe"
  >;
}

export class ZenAssistantTools {
  constructor(readonly dependencies: ZenAssistantToolsDependencies) {}

  forThread(windowId: WindowId, thread: ChatThread): AppManagedToolSet | undefined {
    if (!this.dependencies.zenService.isAssistantThread(windowId, thread.id)) return undefined;
    return {
      definitions: ZEN_ASSISTANT_TOOL_DEFINITIONS,
      execute: async ({ name, inputJson, signal }) => {
        if (signal?.aborted) {
          return {
            result: decodeZenAssistantToolResult({
              action: toolAction(name),
              status: "interrupted",
              message: "Zen action was interrupted.",
            }),
            isError: true,
          };
        }
        try {
          const input: unknown = JSON.parse(inputJson);
          switch (name) {
            case "octant_zen_search_threads": {
              const args = decodeZenAssistantSearchThreadsInput(input);
              return {
                result: decodeZenAssistantToolResult({
                  action: "search-threads",
                  status: "ok",
                  entries: await this.dependencies.zenService.searchThreads(windowId, args.query),
                }),
              };
            }
            case "octant_zen_attach_thread": {
              const args = decodeZenAssistantAttachThreadInput(input);
              const attached = await this.dependencies.zenService.attachThread(
                windowId,
                args,
                signal,
              );
              return {
                result: decodeZenAssistantToolResult({
                  action: "attach-thread",
                  status: "ok",
                  entry: attached.entry,
                  elementId: attached.elementId,
                  version: attached.space.version,
                }),
              };
            }
            case "octant_zen_list_widgets": {
              decodeZenAssistantListWidgetsInput(input);
              return {
                result: decodeZenAssistantToolResult({
                  action: "list-widgets",
                  status: "ok",
                  widgets: ZEN_WIDGET_AVAILABILITY,
                }),
              };
            }
            case "octant_zen_create_widget": {
              const args = decodeZenAssistantCreateWidgetInput(input);
              if (args.kind === "timer") {
                const created = this.dependencies.zenService.createTimerWidget(
                  windowId,
                  args.durationMs ?? DEFAULT_ZEN_TIMER_DURATION_MS,
                  args.expectedVersion,
                );
                return {
                  result: decodeZenAssistantToolResult({
                    action: "create-widget",
                    status: "ok",
                    kind: "timer",
                    elementId: created.elementId,
                    version: created.space.version,
                  }),
                };
              }
              if (args.kind === "notes" || args.kind === "checklist") {
                const space = this.dependencies.zenService.bootstrap(windowId).space;
                if (space === null) throw new ZenError({ reason: "unknown-space" });
                const result = this.dependencies.zenService.handleCommand(
                  {
                    command: "create-widget",
                    spaceId: space.spaceId,
                    kind: args.kind,
                    expectedVersion: args.expectedVersion,
                  },
                  windowId,
                  signal,
                );
                if (result.result !== "mutation") {
                  throw new ZenError({ reason: "recovery-required", spaceId: space.spaceId });
                }
                const element = [...result.space.elements]
                  .reverse()
                  .find(
                    (candidate) =>
                      (candidate.kind === "notes" || candidate.kind === "checklist") &&
                      candidate.kind === args.kind &&
                      candidate.widgetVersion === 0,
                  );
                if (element === undefined) {
                  throw new ZenError({ reason: "recovery-required", spaceId: space.spaceId });
                }
                return {
                  result: decodeZenAssistantToolResult({
                    action: "create-widget",
                    status: "ok",
                    kind: args.kind,
                    elementId: element.elementId,
                    version: result.space.version,
                  }),
                };
              }
              return {
                result: decodeZenAssistantToolResult({
                  action: "create-widget",
                  status: "unavailable",
                  kind: args.kind,
                  message: "This widget is owned by another Zen D slice.",
                }),
                isError: true,
              };
            }
            case "octant_zen_preview_recipe": {
              const args = decodeZenAssistantPreviewRecipeInput(input);
              const preview = this.dependencies.zenService.previewRecipe(
                windowId,
                thread.id,
                args,
                signal,
              );
              return {
                result: decodeZenAssistantToolResult({
                  action: "preview-recipe",
                  status: "ok",
                  preview,
                }),
              };
            }
            case "octant_zen_place_element": {
              const args = decodeZenAssistantPlacementInput(input);
              const result = this.dependencies.zenService.applyAssistantPlacement(windowId, args);
              return {
                result: decodeZenAssistantToolResult({
                  action: "place-element",
                  status: "ok",
                  elementId: args.elementId,
                  version: result.space.version,
                }),
              };
            }
            case "octant_zen_update_appearance": {
              const args = decodeZenAssistantAppearanceInput(input);
              const result = this.dependencies.zenService.applyAssistantAppearance(windowId, args);
              return {
                result: decodeZenAssistantToolResult({
                  action: "update-appearance",
                  status: "ok",
                  appearance: result.space.appearance,
                  version: result.space.version,
                }),
              };
            }
            default:
              return {
                result: decodeZenAssistantToolResult({
                  action: "unknown",
                  status: "unsupported",
                  message: "Zen tool is unknown.",
                }),
                isError: true,
              };
          }
        } catch (error) {
          const reason = error instanceof ZenError ? error.reason : "invalid-input";
          return {
            result: decodeZenAssistantToolResult({
              action: toolAction(name),
              status:
                reason === "stale-version"
                  ? "conflict"
                  : reason === "interrupted"
                    ? "interrupted"
                    : "failed",
              code: reason,
              message: error instanceof Error ? error.message : "Zen action failed.",
            }),
            isError: true,
          };
        }
      },
    };
  }
}

function toolAction(name: string) {
  switch (name) {
    case "octant_zen_search_threads":
      return "search-threads" as const;
    case "octant_zen_attach_thread":
      return "attach-thread" as const;
    case "octant_zen_list_widgets":
      return "list-widgets" as const;
    case "octant_zen_create_widget":
      return "create-widget" as const;
    case "octant_zen_preview_recipe":
      return "preview-recipe" as const;
    case "octant_zen_place_element":
      return "place-element" as const;
    case "octant_zen_update_appearance":
      return "update-appearance" as const;
    default:
      return "unknown" as const;
  }
}

const ZEN_ASSISTANT_TOOL_DEFINITIONS: ReadonlyArray<ProviderToolDefinition> = [
  {
    name: "octant_zen_search_threads",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "octant_zen_attach_thread",
    inputSchema: {
      type: "object",
      properties: {
        catalogRef: { type: "string" },
        expectedVersion: { type: "integer", minimum: 0 },
      },
      required: ["catalogRef", "expectedVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "octant_zen_list_widgets",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "octant_zen_create_widget",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["notes", "checklist", "timer", "reference", "recipe"] },
        expectedVersion: { type: "integer", minimum: 0 },
        durationMs: { type: "integer", minimum: 1, maximum: MAX_ZEN_TIMER_DURATION_MS },
      },
      required: ["kind", "expectedVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "octant_zen_preview_recipe",
    inputSchema: {
      type: "object",
      properties: {
        expectedVersion: { type: "integer", minimum: 0 },
        previewId: { type: "string" },
        recipe: {
          type: "object",
          properties: {
            recipeId: { type: "string" },
            name: { type: "string", maxLength: 120 },
            description: { type: "string", maxLength: 1000 },
            primitives: {
              type: "array",
              items: {
                type: "string",
                enum: ["notes", "checklist", "timer", "text", "link", "media"],
              },
              minItems: 1,
              maxItems: 10,
            },
            fields: { type: "array", maxItems: 20 },
          },
          required: ["recipeId", "name", "primitives", "fields"],
          additionalProperties: false,
        },
      },
      required: ["recipe", "expectedVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "octant_zen_place_element",
    inputSchema: {
      type: "object",
      properties: {
        elementId: { type: "string" },
        expectedVersion: { type: "integer", minimum: 0 },
        action: {
          type: "string",
          enum: ["move-resize", "focus", "minimize", "restore", "remove"],
        },
        geometry: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
      },
      required: ["elementId", "expectedVersion", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "octant_zen_update_appearance",
    inputSchema: {
      type: "object",
      properties: {
        expectedVersion: { type: "integer", minimum: 0 },
        dimming: { type: "integer", minimum: 0, maximum: 90 },
        elementOpacity: { type: "number", minimum: 0.1, maximum: 1 },
      },
      required: ["expectedVersion"],
      additionalProperties: false,
    },
  },
];

const ZEN_WIDGET_AVAILABILITY = [
  { kind: "notes", available: true },
  { kind: "checklist", available: true },
  { kind: "timer", available: true },
  { kind: "reference", available: false, reason: "Not available in D1" },
  { kind: "recipe", available: true },
] as const;
