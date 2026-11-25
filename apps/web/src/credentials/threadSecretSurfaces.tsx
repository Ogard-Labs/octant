import { lazy, Suspense, type ComponentProps } from "react";

// Code and Work both show these. Imported there directly, they split what the
// two share with the window's first load into more chunks, 3 KB larger.
const LoadedThreadSecrets = lazy(() =>
  import("./ThreadSecrets").then((module) => ({ default: module.ThreadSecrets })),
);
const LoadedActiveThreadSecrets = lazy(() =>
  import("./ActiveThreadSecrets").then((module) => ({ default: module.ActiveThreadSecrets })),
);

export function ThreadSecrets(props: ComponentProps<typeof LoadedThreadSecrets>) {
  return (
    <Suspense fallback={null}>
      <LoadedThreadSecrets {...props} />
    </Suspense>
  );
}

export function ActiveThreadSecrets(props: ComponentProps<typeof LoadedActiveThreadSecrets>) {
  return (
    <Suspense fallback={null}>
      <LoadedActiveThreadSecrets {...props} />
    </Suspense>
  );
}
