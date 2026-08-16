import type { WorkspaceTab } from "@octant/contracts/shell";

type CodeTabKind = Extract<WorkspaceTab, { readonly mode: "code" }>["kind"];

interface DeferredCodeAdapter {
  readonly id: "monaco" | "xterm";
  readonly load: () => Promise<unknown>;
}

const monacoAdapter: DeferredCodeAdapter = {
  id: "monaco",
  load: () => import("./MonacoEditorAdapter"),
};

const xtermAdapter: DeferredCodeAdapter = {
  id: "xterm",
  load: () => import("./XtermTerminalAdapter"),
};

export function deferredCodeAdapterFor(kind: CodeTabKind): DeferredCodeAdapter | undefined {
  switch (kind) {
    case "code-file":
    case "code-diff":
      return monacoAdapter;
    case "code-terminal":
      return xtermAdapter;
    default:
      return undefined;
  }
}
