import type { Questionnaire } from "@octant/contracts";
import {
  emptyQuestionnaireDraft,
  type QuestionnaireDraft,
} from "../approvals/workRequestPresentation";

interface StoredDraft {
  readonly definitionKey: string;
  readonly draft: QuestionnaireDraft;
}

const MAX_STORED_DRAFTS = 64;
const storedDrafts = new Map<string, StoredDraft>();

/**
 * Stable definition signature for one questionnaire prompt. If the host sends a
 * changed question set under the same request id, the stale draft is discarded.
 */
export function questionnaireDefinitionKey(prompt: string, questionnaire: Questionnaire): string {
  return JSON.stringify([prompt, questionnaire]);
}

/**
 * Read the saved in-memory draft for a questionnaire, or a fresh empty draft
 * when none exists or the questionnaire definition has changed.
 */
export function readMobileQuestionnaireDraft(
  draftKey: string | undefined,
  definitionKey: string,
  questionnaire: Questionnaire,
): QuestionnaireDraft {
  if (draftKey === undefined) return emptyQuestionnaireDraft(questionnaire);
  const existing = storedDrafts.get(draftKey);
  if (existing === undefined || existing.definitionKey !== definitionKey) {
    storedDrafts.delete(draftKey);
    return emptyQuestionnaireDraft(questionnaire);
  }
  return existing.draft;
}

export function writeMobileQuestionnaireDraft(
  draftKey: string | undefined,
  definitionKey: string,
  draft: QuestionnaireDraft,
): void {
  if (draftKey === undefined) return;
  storedDrafts.delete(draftKey);
  storedDrafts.set(draftKey, { definitionKey, draft });
  while (storedDrafts.size > MAX_STORED_DRAFTS) {
    const oldest = storedDrafts.keys().next().value;
    if (oldest === undefined) break;
    storedDrafts.delete(oldest);
  }
}

export function clearMobileQuestionnaireDraft(draftKey: string | undefined): void {
  if (draftKey === undefined) return;
  storedDrafts.delete(draftKey);
}

/** Test-only reset for the module draft map. */
export function clearAllMobileQuestionnaireDrafts(): void {
  storedDrafts.clear();
}
