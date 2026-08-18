import type { LinkedThreadParallelReviewController } from "./useLinkedThreadParallelReview";
import { LinkedThreadAggregateView } from "./LinkedThreadAggregateView";
import { LinkedThreadPreviewDialog } from "./LinkedThreadPreviewDialog";
import { useParallelRunOutcomes } from "./useParallelRunOutcomes";

export interface LinkedThreadParallelReviewFlowProps {
  readonly controller: LinkedThreadParallelReviewController;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export function LinkedThreadParallelReviewFlow(props: LinkedThreadParallelReviewFlowProps) {
  const controller = props.controller;
  const runs = useParallelRunOutcomes({
    aggregate: controller.aggregate,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
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
        <LinkedThreadAggregateView
          aggregate={controller.aggregate}
          {...(runs.available
            ? {
                runs: {
                  comparison: runs.comparison,
                  busy: runs.busy,
                  ...(runs.message === undefined ? {} : { message: runs.message }),
                  onBringHome: (threadId: string) => void runs.bringHome(threadId),
                  onRefresh: () => void runs.refresh(),
                },
              }
            : {})}
        />
      )}
    </>
  );
}
