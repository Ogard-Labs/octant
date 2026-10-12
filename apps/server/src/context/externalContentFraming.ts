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

/**
 * A body that repeats a frame delimiter would end its own frame early, and the
 * model would read whatever followed as text outside the data. The body used to
 * be inserted verbatim, so a GitHub issue, a Linear issue, or an MCP result
 * could do exactly that. Only the three angle brackets that open a delimiter
 * are rewritten, so the body's words stay readable as data and here-strings or
 * conflict markers in tool output are left alone.
 */
const FRAME_DELIMITER_OPENING = /<<<(?=\s*(?:END_)?OCTANT_EXTERNAL_DATA)/gi;

function withoutFrameDelimiters(body: string): string {
  return body.replace(FRAME_DELIMITER_OPENING, "&lt;&lt;&lt;");
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
    text: `${open}\n${withoutFrameDelimiters(input.body)}\n${EXTERNAL_CONTENT_FRAME_CLOSE}`,
  };
}
