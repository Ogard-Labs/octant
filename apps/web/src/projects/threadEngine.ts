import { readableModelId } from "../providers/providerModelLabel";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

type EngineFacts = Pick<ChatThreadNavigationItem, "modelId" | "provider">;

/**
 * The model a thread runs, without its provider's name in front: a row or card
 * has no model catalogue to ask, so it reads the id the way the composer does
 * for a model no catalogue described.
 */
export function threadModelName(thread: EngineFacts): string | undefined {
  if (thread.modelId === undefined) return undefined;
  const providerName = thread.provider?.displayName;
  const readable = readableModelId(thread.modelId);
  return providerName !== undefined && readable.startsWith(`${providerName} `)
    ? readable.slice(providerName.length + 1)
    : readable;
}

/** The thread's provider with its model beside it ("Claude · Opus 5.5"), as far as either is known. */
export function threadEngine(thread: EngineFacts): string | undefined {
  const parts = [thread.provider?.displayName, threadModelName(thread)].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? undefined : parts.join(" · ");
}
