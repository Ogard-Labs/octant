import { createContext, useContext, type ReactNode } from "react";

export interface WorkspaceContentView {
  readonly open: (key: string, title: string, render: (close: () => void) => ReactNode) => void;
}

export const WorkspaceContentViewContext = createContext<WorkspaceContentView | undefined>(
  undefined,
);
export function useWorkspaceContentView(): WorkspaceContentView | undefined {
  return useContext(WorkspaceContentViewContext);
}
