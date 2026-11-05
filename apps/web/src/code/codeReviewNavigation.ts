import type { CodeCheckoutId, CodeOperationId } from "@octant/contracts";

/** Person-requested navigation only. The host still authorizes every comparison and note. */
export interface CodeReviewFileRequest {
  readonly checkoutId: CodeCheckoutId;
  readonly path: string;
  readonly receiptOperationId: CodeOperationId;
}
