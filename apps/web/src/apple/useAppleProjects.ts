import type { CodeCheckoutId, CodeCheckoutIdentity, CodeThreadId } from "@octant/contracts";
import { decodeAppleProjectPath } from "@octant/contracts/apple-toolchain";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { useEffect, useMemo, useRef } from "react";
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
  /**
   * The checkout's availability as the thread view reports it, used to retry
   * a failed listing. It does not gate the read: the listing endpoint resolves
   * the checkout root itself, so a view stuck on `waiting` can still list —
   * gating on it hid the Simulator tool for the life of the view instead.
   */
  readonly checkoutAvailability?: CodeCheckoutIdentity["availability"] | undefined;
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
  // A listing that ran while the host was still resolving the checkout fails
  // once; when the view's availability next changes, try again. The retry is
  // bounded by the availability transitions (waiting/unavailable/available),
  // so a genuinely unavailable checkout costs one request, not a poll.
  const availability = options.checkoutAvailability;
  const seenAvailability = useRef(availability);
  const status = controller.status;
  const refresh = controller.refresh;
  useEffect(() => {
    if (seenAvailability.current === availability) return;
    seenAvailability.current = availability;
    if (status === "error") void refresh();
  }, [availability, status, refresh]);
  const entries = controller.entries;
  return useMemo(
    () =>
      entries
        // Root entries only: the listing also names an .xcodeproj's own
        // project.xcworkspace, which is part of that project, not a second one.
        .filter(
          (entry) =>
            !String(entry.path).includes("/") &&
            APPLE_PROJECT_SUFFIXES.some((suffix) => String(entry.path).endsWith(suffix)),
        )
        .flatMap((entry) => {
          const listed = String(entry.path);
          try {
            const projectPath = decodeAppleProjectPath(listed);
            return [{ projectPath, name: listed.split("/").at(-1) ?? listed }];
          } catch {
            return [];
          }
        }),
    [entries],
  );
}
