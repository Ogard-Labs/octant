import { lazy, Suspense } from "react";
import type { DockProjectPullRequestReviewToolProps } from "../shell/DockProjectPullRequestReviewTool";
import { DockModuleBoundary } from "../shell/DockModuleBoundary";
import { loading } from "./moduleState";
const Review = lazy(() =>
  import("../shell/DockProjectPullRequestReviewTool").then((module) => ({
    default: module.DockProjectPullRequestReviewTool,
  })),
);
export function ProjectReviewModule(props: DockProjectPullRequestReviewToolProps) {
  return (
    <DockModuleBoundary
      key={`${props.query.projectId}:${props.query.repositoryOwner}/${props.query.repositoryName}:${props.query.number}`}
    >
      <Suspense fallback={loading("Review")}>
        <Review {...props} />
      </Suspense>
    </DockModuleBoundary>
  );
}
