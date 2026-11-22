import { useEffect, useRef, useState } from "react";
import type {
  BrowserSurfaceTabIcon,
  BrowserSurfaceTabIconsRequest,
} from "@octant/contracts/desktop-bridge";
import type { OctantHostBridge } from "../shell/hostBridge";

/**
 * How often the window re-reads its tabs' icons. The host answers with only
 * what changed, so the steady-state cost of the poll is the call itself.
 */
const TAB_ICONS_POLL_MS = 2_000;
const TAB_ICONS_KNOWN_LIMIT = 128;
const EMPTY_TAB_ICONS: ReadonlyMap<string, BrowserTabIcons> = new Map();

export interface BrowserTabIconMemory {
  readonly revision: number;
  readonly dataUrl?: string;
}

export interface BrowserTabIcons {
  readonly activeTabId?: string;
  /** Every open tab's current icon, or none for a tab that has declared none. */
  readonly icons: ReadonlyMap<string, string>;
  /**
   * The context answered asleep: its windows are closed and these are the
   * icons the tabs went to sleep with, so the strip shows them dimmed.
   */
  readonly sleeping?: boolean;
}

/**
 * Fold one context's icon delta into what the window already holds. A row at
 * the remembered revision changed nothing and keeps its image; a row at a new
 * revision carries the new image or, without one, clears the tab's icon. Tabs
 * absent from the read are closed and forgotten. Revisions must always be
 * kept — the next read names them as known — while `changed` tracks only
 * what is worth a re-render: the images on screen.
 */
export function applyTabIconRows(
  previous: ReadonlyMap<string, BrowserTabIconMemory>,
  rows: ReadonlyArray<BrowserSurfaceTabIcon>,
): {
  readonly next: Map<string, BrowserTabIconMemory>;
  readonly activeTabId?: string;
  readonly sleeping: boolean;
  readonly changed: boolean;
} {
  const next = new Map<string, BrowserTabIconMemory>();
  let activeTabId: string | undefined;
  let sleeping = rows.length > 0;
  for (const row of rows) {
    if (row.active) activeTabId = row.tabId;
    if (row.sleeping !== true) sleeping = false;
    const held = previous.get(row.tabId);
    if (held !== undefined && held.revision === row.revision) {
      next.set(row.tabId, held);
    } else {
      next.set(row.tabId, {
        revision: row.revision,
        ...(row.dataUrl === undefined ? {} : { dataUrl: row.dataUrl }),
      });
    }
  }
  let changed = next.size !== previous.size;
  if (!changed) {
    for (const [tabId, entry] of next) {
      const held = previous.get(tabId);
      if (held === undefined || held.dataUrl !== entry.dataUrl) {
        changed = true;
        break;
      }
    }
  }
  return { next, ...(activeTabId === undefined ? {} : { activeTabId }), sleeping, changed };
}

interface HeldContextIcons {
  readonly known: Map<string, BrowserTabIconMemory>;
  readonly activeTabId?: string;
  readonly sleeping?: boolean;
}

interface IconScope {
  readonly hostBridge: OctantHostBridge | undefined;
  readonly threadId: string | undefined;
  readonly contexts: Map<string, HeldContextIcons>;
}

/**
 * Read the window's own Browser contexts' tab icons on a steady poll. Every
 * read carries the revisions the window already holds, so an unchanged icon
 * never crosses the IPC twice; a context that went to sleep still answers
 * with its tabs' last icons rather than being woken for them. Icons are held
 * per bridge and thread: a refusal clears a context's icons at once, and a
 * scope change drops the whole memory so one bridge's icons can never dress
 * another's tabs.
 */
export function useBrowserSurfaceTabIcons(input: {
  readonly hostBridge: OctantHostBridge | undefined;
  readonly threadId: string | undefined;
  readonly contextIds: ReadonlyArray<string>;
  /** Re-read when this changes, such as a surface state publish. */
  readonly refreshKey?: unknown;
}): ReadonlyMap<string, BrowserTabIcons> {
  const [icons, setIcons] = useState<ReadonlyMap<string, BrowserTabIcons>>(
    () => new Map<string, BrowserTabIcons>(),
  );
  const scopeRef = useRef<IconScope>({
    hostBridge: undefined,
    threadId: undefined,
    contexts: new Map<string, HeldContextIcons>(),
  });
  const contextIdsKey = input.contextIds.join("\n");
  const { hostBridge, refreshKey, threadId } = input;

  useEffect(() => {
    // A bridge or thread change is a different authority: nothing held under
    // the old one may show for the new, even briefly.
    if (scopeRef.current.hostBridge !== hostBridge || scopeRef.current.threadId !== threadId) {
      if (scopeRef.current.contexts.size > 0) setIcons(new Map());
      scopeRef.current = { hostBridge, threadId, contexts: new Map() };
    }
    let held = scopeRef.current.contexts;
    const read = hostBridge?.readBrowserSurfaceTabIcons;
    const contextIds = contextIdsKey === "" ? [] : contextIdsKey.split("\n");
    if (read === undefined || threadId === undefined || contextIds.length === 0) {
      if (held.size > 0) {
        held.clear();
        setIcons(new Map());
      }
      return;
    }
    let current = true;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        let changed = false;
        // The whole poll stages into a copy of the last fully committed
        // snapshot: every request names the revisions that snapshot knew,
        // and nothing is acked or rendered until all contexts answered and
        // this poll is still current — a cancelled read acks nothing.
        const staged = new Map(held);
        for (const contextId of contextIds) {
          const prior = staged.get(contextId);
          const known = [...(prior?.known ?? new Map<string, BrowserTabIconMemory>())]
            .slice(0, TAB_ICONS_KNOWN_LIMIT)
            .map(([tabId, memory]) => ({ tabId, revision: memory.revision }));
          const request: BrowserSurfaceTabIconsRequest = { contextId, known, threadId };
          let rows: ReadonlyArray<BrowserSurfaceTabIcon> | undefined;
          try {
            rows = await read(request);
          } catch {
            // A failed call is transient: keep the last icons until a read
            // answers. Only a refusal (undefined) drops them.
            continue;
          }
          if (rows === undefined) {
            // The host refused: this window does not own the context any
            // more, and last-owner icons are not its to keep showing.
            if (staged.delete(contextId)) changed = true;
            continue;
          }
          const merged = applyTabIconRows(prior?.known ?? new Map(), rows);
          // Always remember the answer — a new revision at identical bytes
          // still has to be named as known on the next read or the host will
          // keep resending it.
          staged.set(contextId, {
            known: merged.next,
            ...(merged.activeTabId === undefined ? {} : { activeTabId: merged.activeTabId }),
            ...(merged.sleeping ? { sleeping: true } : {}),
          });
          if (
            merged.changed ||
            merged.activeTabId !== prior?.activeTabId ||
            merged.sleeping !== (prior?.sleeping === true)
          ) {
            changed = true;
          }
        }
        for (const contextId of [...staged.keys()]) {
          if (!contextIds.includes(contextId)) {
            staged.delete(contextId);
            changed = true;
          }
        }
        if (!current) return;
        scopeRef.current = { hostBridge, threadId, contexts: staged };
        held = staged;
        if (changed) {
          setIcons(
            new Map(
              [...staged].map(([contextId, entry]) => [
                contextId,
                {
                  ...(entry.activeTabId === undefined ? {} : { activeTabId: entry.activeTabId }),
                  ...(entry.sleeping === true ? { sleeping: true } : {}),
                  icons: new Map(
                    [...entry.known].flatMap(([tabId, memory]) =>
                      memory.dataUrl === undefined ? [] : [[tabId, memory.dataUrl] as const],
                    ),
                  ),
                },
              ]),
            ),
          );
        }
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), TAB_ICONS_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [contextIdsKey, hostBridge, refreshKey, threadId]);

  // A bridge or thread change is a different authority: the render that
  // carries it already shows nothing, before the effect runs its reset.
  const sameAuthority =
    scopeRef.current.hostBridge === hostBridge && scopeRef.current.threadId === threadId;
  return sameAuthority ? icons : EMPTY_TAB_ICONS;
}
