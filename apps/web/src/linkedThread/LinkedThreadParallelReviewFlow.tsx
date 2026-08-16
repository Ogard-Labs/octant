import type { LinkedThreadParallelReviewController } from "./useLinkedThreadParallelReview";
import { LinkedThreadAggregateView } from "./LinkedThreadAggregateView";
import { LinkedThreadPreviewDialog } from "./LinkedThreadPreviewDialog";

export interface LinkedThreadParallelReviewFlowProps {
  readonly controller: LinkedThreadParallelReviewController;
}

export function LinkedThreadParallelReviewFlow(props: LinkedThreadParallelReviewFlowProps) {
  const controller = props.controller;
  return (
    <>
      {controller.preview === undefined ? null : (
        <LinkedThreadPreviewDialog
          error={controller.errorMessage}
          notice={controller.notice}
          onClose={controller.close}
          onConfirm={() => {
            void controller.confirm();
          }}
          open={controller.dialogOpen}
          preview={controller.preview}
          skillName={controller.skillName}
          submitting={controller.submitting}
        />
      )}
      {controller.aggregate === undefined ? null : (
        <LinkedThreadAggregateView aggregate={controller.aggregate} />
      )}
    </>
  );
}
