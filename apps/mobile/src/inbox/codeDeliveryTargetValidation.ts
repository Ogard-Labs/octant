export interface CodeDeliveryTargetFields {
  readonly branchIntent: string;
  readonly remoteName: string;
  readonly proposedBaseRepository: string;
  readonly proposedBaseBranch: string;
}

export function validateCodeDeliveryTargetFields(
  fields: CodeDeliveryTargetFields,
): string | undefined {
  if (fields.branchIntent.length > 255) {
    return "Delivery branch must be 255 characters or fewer.";
  }
  if (fields.remoteName.length > 255) {
    return "Remote name must be 255 characters or fewer.";
  }
  if (fields.proposedBaseRepository.length > 512) {
    return "Base repository must be 512 characters or fewer.";
  }
  if (fields.proposedBaseBranch.length > 255) {
    return "Base branch must be 255 characters or fewer.";
  }
  return undefined;
}
