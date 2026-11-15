import {
  MAX_IMAGE_DESCRIPTION_CHARACTERS,
  type ImageDescribedBy,
  type NativeHarnessCandidateRejectionReason,
} from "@octant/contracts";

/**
 * The words a model that cannot read images is given in place of one, and
 * the words a refusal says. One definition, so an attached image and a
 * `look` answer read the same in every mode.
 */

const TRUNCATED_MARK = " [description cut short]";

/** A description trimmed and cut to the bound, saying so when it was cut. */
export function boundImageDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_IMAGE_DESCRIPTION_CHARACTERS) return trimmed;
  return `${trimmed.slice(0, MAX_IMAGE_DESCRIPTION_CHARACTERS - TRUNCATED_MARK.length).trimEnd()}${TRUNCATED_MARK}`;
}

/** The text a model that cannot see receives for one attached image. */
export function describedImageText(input: {
  readonly name: string;
  readonly describedBy: ImageDescribedBy;
  readonly description: string;
}): string {
  return `[Image ${input.name}, described by ${input.describedBy.model} (${input.describedBy.provider})]: ${boundImageDescription(input.description)}`;
}

/**
 * Why one Sees images model was passed over, in plain words. The routing
 * reasons are the resolver's own: a Project's provider policy or data rules
 * (`project-incompatible`), a connection that takes no image from Octant
 * (`capability-incompatible`), and a model that is not ready or did not
 * answer (`provider-not-ready`).
 */
const SKIP_WORDS: Partial<Record<NativeHarnessCandidateRejectionReason, string>> = {
  "project-incompatible": "not allowed by this Project's provider policy or data rules",
  "capability-incompatible": "its connection does not take images from Octant",
  "provider-not-ready": "signed out, down, at a usage limit, or did not answer",
  "provider-unconfigured": "turned off or removed",
  "model-unavailable": "not offered by its provider",
};

export function imageDescriberSkipWords(reason: NativeHarnessCandidateRejectionReason): string {
  return SKIP_WORDS[reason] ?? "not usable now";
}

/**
 * The refusal when no Sees images model can describe an image for a model
 * that cannot read one: the plain fix with no model chosen, and each model
 * passed over with why when there were some.
 */
export function imageReadingRefusal(input: {
  readonly model: string;
  readonly skipped: ReadonlyArray<{
    readonly model: string;
    readonly provider: string;
    readonly reason: NativeHarnessCandidateRejectionReason;
  }>;
}): string {
  const fix = `${input.model} can't read images. Set a model that sees images in Model roles.`;
  if (input.skipped.length === 0) return fix;
  const passed = input.skipped
    .slice(0, 4)
    .map((skip) => `${skip.model} (${skip.provider}): ${imageDescriberSkipWords(skip.reason)}`)
    .join("; ");
  return `${input.model} can't read images, and no model in Sees images could describe this one. ${passed}.`.slice(
    0,
    1_000,
  );
}
