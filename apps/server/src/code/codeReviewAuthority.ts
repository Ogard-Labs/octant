import type { CodeOperationCommand } from "@octant/contracts";

/** These person-owned review reads/annotations require the initiating principal to stay current. */
export function requiresLiveCodeReviewAuthority(command: CodeOperationCommand): boolean {
  return (
    command.kind === "prepare-review-target" ||
    command.kind === "observe-turn-review" ||
    command.kind === "list-review-findings" ||
    command.kind === "prepare-review-correction" ||
    command.kind === "create-review-finding" ||
    command.kind === "update-review-finding" ||
    (command.kind === "start-provider-turn" && (command.reviewFindingReferences?.length ?? 0) > 0)
  );
}
