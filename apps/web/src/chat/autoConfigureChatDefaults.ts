import type { ChatCommand, ChatSettings } from "@octant/contracts/chat";
import type { PickerGroup } from "@octant/domain";

type UpdateChatSettingsCommand = Extract<ChatCommand, { kind: "update-chat-settings" }>;

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
    return {
      kind: "update-chat-settings",
      expectedVersion: settings.version,
      defaultProviderInstanceId: group.instance.id,
      defaultModelId: model.id,
      defaultResearchEnabled: settings.defaultResearchEnabled,
      defaultResearchRouting: settings.defaultResearchRouting,
      defaultPersonalityInstructions: settings.defaultPersonalityInstructions,
      ...(settings.searxngBaseUrl === undefined ? {} : { searxngBaseUrl: settings.searxngBaseUrl }),
    };
  }
  return undefined;
}
