import type { ContentOrigin, ContextEntryCategory } from "@octant/contracts";
import { originTaintsThread } from "@octant/domain/untrusted-content-policy";

/**
 * Context assembly framing for externally originated content (Security S2).
 * External content is presented inside data-delimited framing and never merged
 * into system/instruction sections.
 */

export const EXTERNAL_CONTENT_FRAME_OPEN_PREFIX = "<<<OCTANT_EXTERNAL_DATA";
export const EXTERNAL_CONTENT_FRAME_CLOSE = "<<<END_OCTANT_EXTERNAL_DATA>>>";

/** Context categories that carry instructions or system policy — never external data. */
export const INSTRUCTION_CONTEXT_SECTIONS = [
  "provider-framing",
  "octant-policy",
  "user-instructions",
  "project-instructions",
  "extension-instructions",
  "octant-tools",
] as const satisfies ReadonlyArray<ContextEntryCategory>;

export type InstructionContextSection = (typeof INSTRUCTION_CONTEXT_SECTIONS)[number];

export type DataContextSection = Exclude<
  ContextEntryCategory,
  InstructionContextSection | "reserves"
>;

export function isInstructionContextSection(
  section: ContextEntryCategory,
): section is InstructionContextSection {
  return (INSTRUCTION_CONTEXT_SECTIONS as ReadonlyArray<string>).includes(section);
}

export function assertExternalContentNotInInstructionSection(input: {
  readonly origin: ContentOrigin;
  readonly section: ContextEntryCategory;
}): void {
  if (!originTaintsThread(input.origin)) return;
  if (isInstructionContextSection(input.section)) {
    throw new Error(
      `Externally originated ${input.origin} content must never merge into system or instruction section "${input.section}".`,
    );
  }
}

export interface FramedExternalContent {
  readonly section: DataContextSection;
  readonly text: string;
}

/**
 * Frame externally originated content as delimited data for the model.
 * Rejects non-tainting origins and instruction/system sections fail-closed.
 */
export function frameExternalContentForModel(input: {
  readonly origin: ContentOrigin;
  readonly sourceLabel: string;
  readonly body: string;
  readonly section: ContextEntryCategory;
}): FramedExternalContent {
  if (!originTaintsThread(input.origin)) {
    throw new Error(
      `Only tool-result and external-content origins use external data framing; got ${input.origin}.`,
    );
  }
  assertExternalContentNotInInstructionSection({
    origin: input.origin,
    section: input.section,
  });
  if (input.section === "reserves") {
    throw new Error("External content cannot be placed in the reserves section.");
  }
  if (isInstructionContextSection(input.section)) {
    throw new Error("External content cannot be placed in an instruction section.");
  }

  const open = `${EXTERNAL_CONTENT_FRAME_OPEN_PREFIX} origin="${input.origin}" source="${input.sourceLabel}">>>`;
  return {
    section: input.section as DataContextSection,
    text: `${open}\n${input.body}\n${EXTERNAL_CONTENT_FRAME_CLOSE}`,
  };
}
