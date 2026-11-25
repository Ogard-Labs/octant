import { lazy, Suspense } from "react";
import type { HostPullRequestReviewProps } from "../app/HostPullRequestReview";
import { DockModuleBoundary } from "../shell/DockModuleBoundary";
import { loading } from "./moduleState";
const Review = lazy(() =>
  import("../app/HostPullRequestReview").then((module) => ({
    default: module.HostPullRequestReview,
  })),
);
export function HostPullRequestReviewModule(props: HostPullRequestReviewProps) {
  const { projectId, repositoryOwner, repositoryName, number } = props.query;
  return (
    <DockModuleBoundary key={`${projectId}:${repositoryOwner}/${repositoryName}:${number}`}>
      <Suspense fallback={loading("review")}>
        <Review {...props} />
      </Suspense>
    </DockModuleBoundary>
  );
}
