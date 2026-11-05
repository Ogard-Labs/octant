import {
  decodeZenAssistantAppearanceInput,
  decodeZenAssistantCreateWidgetInput,
  decodeZenAssistantGetSpaceInput,
  decodeZenAssistantPinThreadInput,
  decodeZenAssistantPlacementInput,
  decodeZenAssistantPreviewRecipeInput,
  decodeZenAssistantSearchThreadsInput,
  decodeZenAssistantToolResult,
  DEFAULT_ZEN_TIMER_DURATION_MS,
  MAX_ZEN_TIMER_DURATION_MS,
  ZEN_ASSISTANT_TOOL_NAME,
  ZenAssistantOperation,
  ZenError,
  type ChatThread,
  type ProviderToolDefinition,
  type WindowId,
  type ZenAssistantAction,
  type ZenAssistantToolResult,
} from "@octant/contracts";
import { Schema } from "effect";
import type { AppManagedToolSet } from "../chat/chatTurnRunner";
import { withToolFamilyHelp } from "../providers/appManagedToolSet";
import type { ZenService } from "./zenService";

export interface ZenAssistantToolsDependencies {
  readonly zenService: Pick<
    ZenService,
    | "isAssistantThread"
    | "searchThreads"
    | "pinThread"
    | "bootstrap"
    | "handleCommand"
    | "applyAssistantPlacement"
    | "applyAssistantAppearance"
    | "createTimerWidget"
    | "previewRecipe"
  >;
}

const isOperation = Schema.is(ZenAssistantOperation);

export class ZenAssistantTools {
  constructor(readonly dependencies: ZenAssistantToolsDependencies) {}

  forThread(windowId: WindowId, thread: ChatThread): AppManagedToolSet | undefined {
    if (!this.dependencies.zenService.isAssistantThread(windowId, thread.id)) return undefined;
    return withToolFamilyHelp(
      {
        definitions: [ZEN_ASSISTANT_TOOL_DEFINITION],
        execute: async ({ name, inputJson, signal }) => {
          if (name !== ZEN_ASSISTANT_TOOL_NAME) {
            return failure({
              action: "unknown",
              status: "unsupported",
              message: "Zen tool is unknown.",
            });
          }
          let input: unknown;
          try {
            input = JSON.parse(inputJson);
          } catch {
            input = undefined;
          }
          const { operation, rest } = splitOperation(input);
          if (operation === undefined) {
            return failure({
              action: "unknown",
              status: "unsupported",
              code: "invalid-input",
              message:
                "operation must be one of help, " + ZenAssistantOperation.literals.join(", "),
            });
          }
          if (signal?.aborted) {
            return failure({
              action: operation,
              status: "interrupted",
              message: "Zen action was interrupted.",
            });
          }
          try {
            return { result: await this.#run(windowId, thread, operation, rest, signal) };
          } catch (error) {
            return this.#failureFor(windowId, operation, error);
          }
        },
      },
      { [ZEN_ASSISTANT_TOOL_NAME]: ZEN_ASSISTANT_TOOL_HELP },
    );
  }

  async #run(
    windowId: WindowId,
    thread: ChatThread,
    operation: ZenAssistantOperation,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<ZenAssistantToolResult> {
    const zen = this.dependencies.zenService;
    switch (operation) {
      case "get-space": {
        decodeZenAssistantGetSpaceInput(input);
        const space = zen.bootstrap(windowId).space;
        if (space === null) throw new ZenError({ reason: "unknown-space" });
        return decodeZenAssistantToolResult({
          action: "get-space",
          status: "ok",
          version: space.version,
          dimming: space.appearance.dimming,
          elementOpacity: space.appearance.elementOpacity,
          elements: space.elements.map((element) => ({
            elementId: element.elementId,
            kind: element.kind,
            ...("title" in element && element.title !== undefined ? { title: element.title } : {}),
            geometry: element.geometry,
            zIndex: element.zIndex,
            minimized: element.minimized,
          })),
        });
      }
      case "search-threads": {
        const args = decodeZenAssistantSearchThreadsInput(input);
        return decodeZenAssistantToolResult({
          action: "search-threads",
          status: "ok",
          entries: await zen.searchThreads(windowId, args.query),
        });
      }
      case "pin-thread": {
        const args = decodeZenAssistantPinThreadInput(input);
        const pinned = await zen.pinThread(windowId, args, signal);
        return decodeZenAssistantToolResult({
          action: "pin-thread",
          status: "ok",
          entry: pinned.entry,
          elementId: pinned.elementId,
          version: pinned.space.version,
        });
      }
      case "create-widget": {
        const args = decodeZenAssistantCreateWidgetInput(input);
        if (args.kind === "timer") {
          const created = zen.createTimerWidget(
            windowId,
            args.durationMs ?? DEFAULT_ZEN_TIMER_DURATION_MS,
            args.expectedVersion,
          );
          return decodeZenAssistantToolResult({
            action: "create-widget",
            status: "ok",
            kind: "timer",
            elementId: created.elementId,
            version: created.space.version,
          });
        }
        const space = zen.bootstrap(windowId).space;
        if (space === null) throw new ZenError({ reason: "unknown-space" });
        const result = zen.handleCommand(
          {
            command: "create-widget",
            spaceId: space.spaceId,
            kind: args.kind,
            expectedVersion: args.expectedVersion,
          },
          windowId,
          signal,
        );
        if (!("result" in result && result.result === "mutation")) {
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
        return decodeZenAssistantToolResult({
          action: "create-widget",
          status: "ok",
          kind: args.kind,
          elementId: element.elementId,
          version: result.space.version,
        });
      }
      case "preview-recipe": {
        const args = decodeZenAssistantPreviewRecipeInput(input);
        return decodeZenAssistantToolResult({
          action: "preview-recipe",
          status: "ok",
          preview: zen.previewRecipe(windowId, thread.id, args, signal),
        });
      }
      case "place-element": {
        const args = decodeZenAssistantPlacementInput(input);
        const result = zen.applyAssistantPlacement(windowId, args);
        return decodeZenAssistantToolResult({
          action: "place-element",
          status: "ok",
          elementId: args.elementId,
          version: result.space.version,
        });
      }
      case "update-appearance": {
        const args = decodeZenAssistantAppearanceInput(input);
        const result = zen.applyAssistantAppearance(windowId, args);
        return decodeZenAssistantToolResult({
          action: "update-appearance",
          status: "ok",
          appearance: result.space.appearance,
          version: result.space.version,
        });
      }
    }
  }

  #failureFor(windowId: WindowId, action: ZenAssistantAction, error: unknown) {
    const reason = error instanceof ZenError ? error.reason : "invalid-input";
    const message = error instanceof Error ? error.message : "Zen action failed.";
    if (reason === "stale-version") {
      // The model never saw the change that beat it, so the conflict says
      // which version is current; without it a model fails its retry too.
      const current = this.dependencies.zenService.bootstrap(windowId).space;
      if (current !== null) {
        return failure({
          action,
          status: "conflict",
          code: "stale-version",
          version: current.version,
          message: "This Zen space changed since that version. Read it again with get-space.",
        });
      }
    }
    return failure({
      action,
      status: reason === "interrupted" ? "interrupted" : "failed",
      code: reason,
      message,
    });
  }
}

function failure(result: unknown) {
  return { result: decodeZenAssistantToolResult(result), isError: true };
}

/** The operation a call names and the rest of its input, which each operation decodes strictly. */
function splitOperation(input: unknown): {
  readonly operation: ZenAssistantOperation | undefined;
  readonly rest: unknown;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { operation: undefined, rest: undefined };
  }
  const { operation, ...rest } = input as Record<string, unknown>;
  return { operation: isOperation(operation) ? operation : undefined, rest };
}

const ZEN_ASSISTANT_TOOL_DEFINITION: ProviderToolDefinition = {
  name: ZEN_ASSISTANT_TOOL_NAME,
  description:
    "Arrange this Zen space for the person. Start with get-space: it returns the space's version and each element's elementId, and every change takes that version as expectedVersion. search-threads finds threads to pin and pin-thread pins one as a card; create-widget adds an empty Notes, Checklist, or Timer widget; preview-recipe proposes a custom widget the person must confirm; place-element moves, resizes, focuses, minimizes, restores, or removes an element; update-appearance changes dimming and element opacity. A change against an out-of-date version is refused as a conflict that changes nothing and names the current version. get-space and search-threads only read. Call operation help for full usage.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["help", ...ZenAssistantOperation.literals],
      },
      expectedVersion: { type: "integer", minimum: 0 },
      query: { type: "string", maxLength: 200 },
      catalogRef: { type: "string" },
      kind: { type: "string", enum: ["notes", "checklist", "timer"] },
      durationMs: { type: "integer", minimum: 1, maximum: MAX_ZEN_TIMER_DURATION_MS },
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
      elementId: { type: "string" },
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
      dimming: { type: "integer", minimum: 0, maximum: 90 },
      elementOpacity: { type: "number", minimum: 0.1, maximum: 1 },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};

const ZEN_ASSISTANT_TOOL_HELP = [
  "Every operation acts on the Zen space in front of this window; none names another space or window.",
  "get-space takes nothing and returns version, dimming, elementOpacity, and elements: each element's elementId, kind, title when it has one, geometry (x, y, width, height), zIndex, and minimized. It reads layout only, never what a note, checklist, or pinned thread says.",
  "search-threads takes query (at most 200 characters; empty lists every thread this window can open). It matches a thread's title, mode, Project name, status, or last activity, newest activity first; each entry's catalogRef is what pin-thread takes.",
  "pin-thread takes catalogRef and expectedVersion and adds the thread as a card the person can read and reply in; a thread this window can no longer open is refused.",
  "create-widget takes kind (notes, checklist, or timer) and expectedVersion, and for a timer durationMs (25 minutes when omitted, at most 8 hours; refused for any other kind). It returns the new elementId.",
  "preview-recipe takes expectedVersion, recipe (recipeId, name, one to ten primitives from notes, checklist, timer, text, link, media, up to twenty fields, optional description), and previewId to replace a preview made earlier. It creates nothing: the widget exists only once the person confirms the preview in Zen. A preview expires after ten minutes or when the space changes, and at most four are open at once.",
  "place-element takes elementId, expectedVersion, and action: move-resize (with geometry; width 200 to 2400, height 100 to 1400), focus (bring to front), minimize, restore, or remove.",
  "update-appearance takes expectedVersion and at least one of dimming (0 to 90) and elementOpacity (0.1 to 1).",
  "Every change returns the space's new version; use it for the next change. A change made against an out-of-date version changes nothing and comes back with status conflict and the current version: call get-space, check the element still exists, and retry with that version.",
].join(" ");
