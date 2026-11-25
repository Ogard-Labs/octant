import type { MobileInboxRow } from "@octant/client-runtime";

/** What a Home count lists. */
export type CountedThreads = "attention" | "working" | "review";

export type MobileStackParams = {
  // Each place's first screen. Their names differ from the places that hold them.
  readonly homeRoot: undefined;
  readonly threadsRoot: undefined;
  readonly inboxRoot: undefined;
  readonly counted: { readonly view: CountedThreads };
  readonly thread: { readonly row: MobileInboxRow; readonly focusTurnId?: string | undefined };
  readonly settings: {
    readonly notice?: string | undefined;
    readonly linkOpened?: number | undefined;
  };
  readonly pair: { readonly entryMode: "add" | "scan" };
  readonly todos: undefined;
};
