import { createContext, lazy, Suspense, type RefObject } from "react";
import type { ComposerStashBinding } from "./useComposerStash";

export const ComposerStashScopeContext = createContext<
  { readonly host: string | undefined; readonly windowId?: string | undefined } | undefined
>(undefined);

export interface ComposerStashControlsProps {
  readonly binding: ComposerStashBinding;
  readonly surface: RefObject<HTMLElement | null>;
}

const ComposerStashActions = lazy(() =>
  import("./ComposerStashActions").then(({ ComposerStashActions }) => ({
    default: ComposerStashActions,
  })),
);

export function ComposerStashControls(props: ComposerStashControlsProps) {
  return (
    <Suspense fallback={null}>
      <ComposerStashActions {...props} />
    </Suspense>
  );
}
