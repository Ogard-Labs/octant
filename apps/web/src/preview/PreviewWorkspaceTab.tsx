import { useMemo, type ReactNode } from "react";
import type { PreviewClient } from "@octant/client-runtime/preview-client";
import type { PreviewTarget } from "@octant/contracts/previews";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { PreviewShell } from "./PreviewShell";
import { usePreviewController } from "./usePreviewController";

/**
 * Renders a persistent preview tab. The tab carries only the opaque target
 * identity the host preview service already authorized; the renderer
 * reconstructs the `PreviewTarget` and reopens it through the existing
 * preview contracts. The host reauthorizes every open/chunk/refresh, so a
 * missing/changed/revoked/offline source restores as an honest
 * unavailable/stale placeholder instead of guessing a replacement file.
 */
export interface PreviewWorkspaceTabProps {
  readonly tab: Extract<WorkspaceTab, { readonly kind: "preview" }>;
  readonly client: PreviewClient | undefined;
}

export function PreviewWorkspaceTab(props: PreviewWorkspaceTabProps): ReactNode {
  // Memoize the reconstructed target so the preview controller's effect does
  // not re-run on every parent render. The tab's opaque identity is stable
  // across renders unless the host reissues a new targetId.
  const target: PreviewTarget = useMemo(
    () => ({
      targetId: props.tab.targetId,
      projectId: props.tab.projectId,
      hostId: props.tab.hostId,
      kind: props.tab.targetKind,
      opaqueRef: props.tab.opaqueRef,
      displayName: props.tab.displayName,
      ...(props.tab.boundCodeThreadId === undefined
        ? {}
        : { boundCodeThreadId: props.tab.boundCodeThreadId }),
    }),
    [
      props.tab.targetId,
      props.tab.projectId,
      props.tab.hostId,
      props.tab.targetKind,
      props.tab.opaqueRef,
      props.tab.displayName,
      props.tab.boundCodeThreadId,
    ],
  );
  const controller = usePreviewController({
    client: props.client,
    target,
    // The tab is rendered only when active, so the preview lifecycle is
    // bound to the tab's visibility. Reauthorization happens on every open.
    enabled: true,
  });
  return (
    <PreviewShell
      target={target}
      model={controller.model}
      onRetry={controller.retry}
      onCancel={controller.cancel}
      onHandoff={controller.handoff}
      handoffPending={controller.handoffPending}
      onCancelHandoff={controller.cancelHandoff}
      {...(controller.handoffMessage === undefined
        ? {}
        : { handoffMessage: controller.handoffMessage })}
    />
  );
}
