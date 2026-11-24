import { createContext, lazy, Suspense, type RefObject } from "react";
import type { ComposerStashBinding } from "./useComposerStash";

export interface ComposerStashScope {
  readonly host: string;
  readonly windowId?: string | undefined;
  readonly reconcilePurges?: (() => Promise<void>) | undefined;
}

export const ComposerStashScopeContext = createContext<ComposerStashScope | undefined>(undefined);

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
