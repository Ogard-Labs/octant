import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { useMemo } from "react";
import { useCodeFileListingController } from "../code/useCodeFileListingController";

export interface AppleProjectEntry {
  /** Checkout-relative path, exactly as the host listed it. */
  readonly projectPath: string;
  readonly name: string;
}

const APPLE_PROJECT_SUFFIXES = [".xcodeproj", ".xcworkspace"] as const;

export interface UseAppleProjectsOptions {
  readonly client?: CodeFileListingClient;
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

/**
 * The Apple projects at the root of a Code thread's checkout.
 *
 * Read from the host's own bounded listing rather than guessed from the
 * Project name: a thread whose checkout holds no Xcode project reports none,
 * and the workbench entry point simply does not appear. The listing is not
 * watched — this feeds a menu that is built when it opens, and holding a
 * change stream open for that would cost a connection to say nothing.
 */
export function useAppleProjects(
  options: UseAppleProjectsOptions,
): ReadonlyArray<AppleProjectEntry> {
  const controller = useCodeFileListingController({
    enabled: options.threadId !== undefined && options.checkoutId !== undefined,
    watch: false,
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.checkoutId === undefined ? {} : { checkoutId: options.checkoutId }),
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.windowCapability === undefined
      ? {}
      : { windowCapability: options.windowCapability }),
  });
  const entries = controller.entries;
  return useMemo(
    () =>
      entries
        .filter((entry) =>
          APPLE_PROJECT_SUFFIXES.some((suffix) => String(entry.path).endsWith(suffix)),
        )
        .map((entry) => {
          const projectPath = String(entry.path);
          return { projectPath, name: projectPath.split("/").at(-1) ?? projectPath };
        }),
    [entries],
  );
}
