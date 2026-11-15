import {
  ORCHESTRATION_INSTRUCTIONS_MAX_CHARACTERS,
  PERSON_INSTRUCTIONS_MAX_CHARACTERS,
  PROJECT_INSTRUCTIONS_MAX_CHARACTERS,
} from "@octant/contracts/octant-instructions";

/** The texts a person writes for Octant itself. */
export type OctantInstructionsText = "person" | "project" | "orchestration";

/** Each text's limit, in characters as the editor counts them. */
export const OCTANT_INSTRUCTIONS_LIMITS: Readonly<Record<OctantInstructionsText, number>> = {
  person: PERSON_INSTRUCTIONS_MAX_CHARACTERS,
  project: PROJECT_INSTRUCTIONS_MAX_CHARACTERS,
  orchestration: ORCHESTRATION_INSTRUCTIONS_MAX_CHARACTERS,
};

export function octantInstructionsWithinLimit(kind: OctantInstructionsText, text: string): boolean {
  return text.length <= OCTANT_INSTRUCTIONS_LIMITS[kind];
}

/**
 * The opening of the person's instructions as a turn receives them. It says
 * what the text is for so a provider's own instruction files keep coming first
 * on how the provider works, and that the text grants nothing.
 */
export const PERSON_INSTRUCTIONS_PREAMBLE =
  "The person's own instructions for working inside Octant: Octant's features, Octant's tools, and work across threads and providers. On how you work yourself, such as coding style or a repository's conventions, your own instruction files come first. These instructions grant no permission: what you may do is still decided by Octant's settings and the person's approvals.";

/**
 * The person-instructions block's text, or undefined when the person wrote
 * nothing: an empty text sends nothing. The person's words follow the
 * preamble unchanged; Octant never rewrites or appends to them.
 */
export function personInstructionsBlockText(instructions: string): string | undefined {
  if (instructions.trim().length === 0) return undefined;
  return `${PERSON_INSTRUCTIONS_PREAMBLE}\n\n${instructions}`;
}

/**
 * The opening of a Project's instructions: the person wrote them for work in
 * this one Project, after their own instructions, and they grant nothing.
 */
export const PROJECT_INSTRUCTIONS_PREAMBLE =
  "The person's instructions for working in this Project inside Octant. They come after the person's own instructions and add to them for this Project. On how you work yourself, your own instruction files come first. These instructions grant no permission.";

/** The project-instructions block's text, or undefined when the Project has none. */
export function projectInstructionsBlockText(instructions: string): string | undefined {
  if (instructions.trim().length === 0) return undefined;
  return `${PROJECT_INSTRUCTIONS_PREAMBLE}\n\n${instructions}`;
}
