import { lazy, Suspense, type ComponentProps } from "react";

// Code and Work both show this. Imported there directly, it splits what the
// two share with the window's first load into more chunks, 3 KB larger.
const LoadedThreadSecrets = lazy(() =>
  import("./ThreadSecrets").then((module) => ({ default: module.ThreadSecrets })),
);

export function ThreadSecrets(props: ComponentProps<typeof LoadedThreadSecrets>) {
  return (
    <Suspense fallback={null}>
      <LoadedThreadSecrets {...props} />
    </Suspense>
  );
}
