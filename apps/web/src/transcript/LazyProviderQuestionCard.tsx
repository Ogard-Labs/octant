import { lazy, Suspense } from "react";
import type { ProviderQuestionCardProps } from "./ProviderQuestionCard";
import type { QuestionnaireCardProps } from "./QuestionnaireCard";

const ProviderQuestionCardImpl = lazy(() =>
  import("./ProviderQuestionCard").then((module) => ({ default: module.ProviderQuestionCard })),
);

const QuestionnaireCardImpl = lazy(() =>
  import("./QuestionnaireCard").then((module) => ({ default: module.QuestionnaireCard })),
);

/**
 * Loads the question card and its radio-group adapter only when a turn is
 * actually waiting on an answer, keeping them out of the window's initial load.
 */
export function LazyProviderQuestionCard(props: ProviderQuestionCardProps) {
  return (
    <Suspense fallback={null}>
      <ProviderQuestionCardImpl {...props} />
    </Suspense>
  );
}

export function LazyQuestionnaireCard(props: QuestionnaireCardProps) {
  return (
    <Suspense fallback={null}>
      <QuestionnaireCardImpl {...props} />
    </Suspense>
  );
}
