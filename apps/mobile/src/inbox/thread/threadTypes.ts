import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import type { SelectedThreadGuard } from "./selectedThreadGuard";

/** The part of the selected row the thread hooks key their work on. */
export interface ThreadTarget {
  readonly identity: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly mode: MobileInboxRow["mode"];
}

export interface ThreadUi {
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (message: string | undefined) => void;
}

export interface MutationGate {
  readonly allowProductMutations: boolean;
  readonly message: string;
}

export interface ThreadHookInput {
  readonly transport: MobileRemoteTransport | undefined;
  /** Undefined when nothing is selected or the selected thread is another mode. */
  readonly target: ThreadTarget | undefined;
  readonly guard: SelectedThreadGuard;
  readonly ui: ThreadUi;
  readonly gate: MutationGate;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
}

export interface RefreshOptions {
  readonly quiet?: boolean;
}
