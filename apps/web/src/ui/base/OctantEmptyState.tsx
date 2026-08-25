import type { ReactNode } from "react";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateCopy,
  EmptyStateDescription,
  EmptyStateEyebrow,
  EmptyStateMedia,
  EmptyStateTitle,
} from "../shadcn/empty-state";

export {
  EmptyState as OctantEmptyStateRoot,
  EmptyStateActions as OctantEmptyStateActions,
  EmptyStateCopy as OctantEmptyStateCopy,
  EmptyStateDescription as OctantEmptyStateDescription,
  EmptyStateEyebrow as OctantEmptyStateEyebrow,
  EmptyStateMedia as OctantEmptyStateMedia,
  EmptyStateTitle as OctantEmptyStateTitle,
};

export interface OctantEmptyStateProps {
  readonly action?: ReactNode;
  readonly className?: string;
  readonly eyebrow?: string;
  readonly icon?: ReactNode;
  readonly message: ReactNode;
  readonly role?: "alert" | "status";
  readonly title: string;
  readonly tone?: "neutral" | "warning" | "destructive";
}

/** Icon + eyebrow + title + message + action recipe for connection/error/empty states. */
export function OctantEmptyState({
  action,
  className,
  eyebrow,
  icon,
  message,
  role,
  title,
  tone = "neutral",
}: OctantEmptyStateProps) {
  const hasIcon = icon !== undefined;
  return (
    <EmptyState className={className} role={role}>
      {hasIcon ? <EmptyStateMedia tone={tone}>{icon}</EmptyStateMedia> : null}
      <EmptyStateCopy className={hasIcon ? undefined : "col-span-2"}>
        {eyebrow === undefined ? null : <EmptyStateEyebrow>{eyebrow}</EmptyStateEyebrow>}
        <EmptyStateTitle>{title}</EmptyStateTitle>
        <EmptyStateDescription>{message}</EmptyStateDescription>
      </EmptyStateCopy>
      {action === undefined ? null : (
        <EmptyStateActions className={hasIcon ? undefined : "col-span-2 col-start-1"}>
          {action}
        </EmptyStateActions>
      )}
    </EmptyState>
  );
}
