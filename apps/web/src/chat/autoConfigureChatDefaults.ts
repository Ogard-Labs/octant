import type { ChatCommand, ChatSettings } from "@octant/contracts/chat";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";

type UpdateChatSettingsCommand = Extract<ChatCommand, { kind: "update-chat-settings" }>;

/**
 * The command that changes only the default model, carrying every other Chat
 * setting through unchanged.
 *
 * The update command replaces the whole settings record, so anything omitted
 * here would be silently reset. Building it in one place is what keeps a model
 * choice from clearing a research endpoint the user configured elsewhere.
 */
export function chatDefaultModelCommand(
  settings: ChatSettings,
  selection: ModelPickerSelection,
): UpdateChatSettingsCommand {
  return {
    kind: "update-chat-settings",
    expectedVersion: settings.version,
    defaultProviderInstanceId: selection.providerInstanceId,
    defaultModelId: selection.modelId,
    defaultResearchEnabled: settings.defaultResearchEnabled,
    defaultResearchRouting: settings.defaultResearchRouting,
    defaultPersonalityInstructions: settings.defaultPersonalityInstructions,
    ...(settings.searxngBaseUrl === undefined ? {} : { searxngBaseUrl: settings.searxngBaseUrl }),
  };
}

/**
 * Resolves a fresh Chat profile from the already eligible provider picker pool.
 * Explicit defaults always win; provider discovery and enablement remain the
 * boundary that decides which groups can appear here.
 */
export function autoConfigureChatDefaults(
  settings: ChatSettings,
  groups: ReadonlyArray<PickerGroup>,
): UpdateChatSettingsCommand | undefined {
  if (settings.defaultProviderInstanceId !== undefined && settings.defaultModelId !== undefined) {
    return undefined;
  }
  for (const group of groups) {
    const model = group.sections.flatMap((section) => section.models)[0]?.model;
    if (model === undefined) continue;
    return chatDefaultModelCommand(settings, {
      providerInstanceId: group.instance.id,
      modelId: model.id,
    });
  }
  return undefined;
}
