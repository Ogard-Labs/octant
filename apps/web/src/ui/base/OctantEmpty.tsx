import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyDescription,
  EmptyEyebrow,
  EmptyMedia,
  EmptyTitle,
} from "../shadcn/empty";

export {
  Empty as OctantEmptyRoot,
  EmptyContent as OctantEmptyContent,
  EmptyHeader as OctantEmptyHeader,
  EmptyDescription as OctantEmptyDescription,
  EmptyEyebrow as OctantEmptyEyebrow,
  EmptyMedia as OctantEmptyMedia,
  EmptyTitle as OctantEmptyTitle,
};

export interface OctantEmptyProps {
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
export function OctantEmpty({
  action,
  className,
  eyebrow,
  icon,
  message,
  role,
  title,
  tone = "neutral",
}: OctantEmptyProps) {
  const hasIcon = icon !== undefined;
  return (
    <Empty className={className} role={role}>
      {hasIcon ? <EmptyMedia tone={tone}>{icon}</EmptyMedia> : null}
      <EmptyHeader className={hasIcon ? undefined : "col-span-2"}>
        {eyebrow === undefined ? null : <EmptyEyebrow>{eyebrow}</EmptyEyebrow>}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      {action === undefined ? null : (
        <EmptyContent className={hasIcon ? undefined : "col-span-2 col-start-1"}>
          {action}
        </EmptyContent>
      )}
    </Empty>
  );
}
