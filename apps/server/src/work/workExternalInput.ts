import { createHash } from "node:crypto";
import {
  decodeWorkExternalInputReceipt,
  type WorkExternalInputReceipt,
} from "@octant/contracts/work-turns";
import type { FramedExternalContent } from "../context/externalContentFraming";

/** The host's accepted input, not proof of provider completion or external effects. */
export function workExternalInputReceipt(input: {
  readonly referenceId: string;
  readonly content: FramedExternalContent;
}): WorkExternalInputReceipt {
  return decodeWorkExternalInputReceipt({
    referenceId: input.referenceId,
    digest: createHash("sha256")
      .update(JSON.stringify([input.content.section, input.content.text]))
      .digest("hex"),
  });
}

export function sameWorkExternalInput(
  left: WorkExternalInputReceipt | undefined,
  right: WorkExternalInputReceipt | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.referenceId === right.referenceId && left.digest === right.digest;
}
