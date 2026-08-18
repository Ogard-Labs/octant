import type { ZenClient } from "@octant/client-runtime/zen-client";
import { createZenClient } from "@octant/client-runtime/zen-client";
import type {
  ZenAssistantSnapshot,
  ZenAppearance,
  ZenChecklistItemId,
  ZenCommand,
  ZenElementPayload,
  ZenFocusZone,
  ZenFocusZoneCommand,
  ZenSpace,
  ZenSpaceId,
  ZenThreadCatalogEntry,
  ZenThreadCatalogRef,
  ZenThreadContinuationTarget,
  ZenTimerAction,
  ZenViewport,
} from "@octant/contracts/zen";
import { MAX_ZEN_BACKGROUND_BYTES } from "@octant/contracts/zen";
import { cycleZenSpace } from "@octant/domain";
import type { WindowId } from "@octant/contracts/shell";
import type { CodeCheckoutId, CodeTerminalId, CodeThreadId } from "@octant/contracts/code";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const ZEN_PRESENTATION_STORAGE_PREFIX = "octant:zen-presentation:";

export interface ZenPresentationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UseZenControllerOptions {
  readonly client?: ZenClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly windowId?: WindowId;
  readonly storage?: ZenPresentationStorage;
}

function defaultStorage(): ZenPresentationStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function readPresentationActive(
  storage: ZenPresentationStorage | undefined,
  windowId: WindowId | undefined,
): boolean {
  if (storage === undefined || windowId === undefined) return false;
  try {
    return storage.getItem(`${ZEN_PRESENTATION_STORAGE_PREFIX}${windowId}`) === "active";
  } catch {
    return false;
  }
}

function writePresentationActive(
  storage: ZenPresentationStorage | undefined,
  windowId: WindowId | undefined,
  active: boolean,
): void {
  if (storage === undefined || windowId === undefined) return;
  try {
    const key = `${ZEN_PRESENTATION_STORAGE_PREFIX}${windowId}`;
    if (active) storage.setItem(key, "active");
    else storage.removeItem(key);
  } catch {
    // ignore quota / private-mode failures
  }
}

export function useZenController(options: UseZenControllerOptions) {
  const storage = options.storage ?? defaultStorage();
  const fallbackClient = useMemo(
    () =>
      options.serverUrl !== undefined && options.windowCapability !== undefined
        ? createZenClient({
            baseUrl: options.serverUrl,
            fetch: globalThis.fetch,
            windowCapability: options.windowCapability,
          })
        : undefined,
    [options.serverUrl, options.windowCapability],
  );
  const client = options.client ?? fallbackClient;
  const windowId = options.windowId;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [active, setActive] = useState(false);
  const [space, setSpace] = useState<ZenSpace | null>(null);
  const [focusZone, setFocusZone] = useState<ZenFocusZone | null>(null);
  const presentationSpace = useRef<ZenSpace | null>(null);
  const presentationQueue = useRef<
    Array<{
      readonly next: { readonly active?: boolean; readonly barCollapsed?: boolean };
      readonly exitGate?: boolean;
    }>
  >([]);
  const presentationRunning = useRef(false);
  const [barCollapsed, setBarCollapsedState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryNeeded, setRecoveryNeeded] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  const [threadEntries, setThreadEntries] = useState<ReadonlyArray<ZenThreadCatalogEntry>>([]);
  const [threadQuery, setThreadQuery] = useState("");
  const [panelBusy, setPanelBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistant, setAssistant] = useState<ZenAssistantSnapshot | null>(null);
  const [backgroundObjectUrl, setBackgroundObjectUrl] = useState<string | undefined>(undefined);
  const [backgroundStatus, setBackgroundStatus] = useState<"ready" | "loading" | "unavailable">(
    "ready",
  );
  const backgroundObjectUrlRef = useRef<string | undefined>(undefined);
  const restoring = useRef(false);

  useEffect(() => {
    presentationSpace.current = space;
  }, [space]);

  const markActive = useCallback(
    (next: boolean) => {
      setActive(next);
      writePresentationActive(storage, windowId, next);
    },
    [storage, windowId],
  );

  const applyPresentation = useCallback(
    async (
      next: { readonly active?: boolean; readonly barCollapsed?: boolean },
      exitGate: boolean = false,
    ) => {
      const previousSpace = presentationSpace.current;

      if (client === undefined || previousSpace === null) {
        if (next.active !== undefined) markActive(next.active);
        if (next.barCollapsed !== undefined) setBarCollapsedState(next.barCollapsed);
        return;
      }

      const previousBarCollapsed = previousSpace.barCollapsed;

      const optimistic: ZenSpace = {
        ...previousSpace,
        version: (previousSpace.version + 1) as ZenSpace["version"],
        ...(typeof next.active === "boolean" ? { active: next.active } : {}),
        ...(typeof next.barCollapsed === "boolean" ? { barCollapsed: next.barCollapsed } : {}),
      };

      markActive(optimistic.active);
      setBarCollapsedState(optimistic.barCollapsed);
      setSpace(optimistic);
      presentationSpace.current = optimistic;
      setMessage(undefined);

      const keepExit = (base: ZenSpace): ZenSpace => ({
        ...base,
        active: false,
      });

      const failExit = (detail: string) => {
        markActive(false);
        setBarCollapsedState(previousBarCollapsed);
        const safe = keepExit(previousSpace);
        setSpace(safe);
        presentationSpace.current = safe;
        setMessage(`Zen exit could not be saved. ${detail} The workspace is still available.`);
      };

      try {
        const result = await client.command({
          command: "set-presentation",
          spaceId: previousSpace.spaceId,
          expectedVersion: previousSpace.version,
          ...(typeof next.active === "boolean" ? { active: next.active } : {}),
          ...(typeof next.barCollapsed === "boolean" ? { barCollapsed: next.barCollapsed } : {}),
        });
        if (result.result === "mutation" && mounted.current) {
          // Reordered or late responses must not overwrite a newer optimistic/server state.
          if (result.space.version >= optimistic.version) {
            const accepted = exitGate ? keepExit(result.space) : result.space;
            setSpace(accepted);
            markActive(accepted.active);
            setBarCollapsedState(accepted.barCollapsed);
            presentationSpace.current = accepted;
          }
        }
      } catch (error) {
        if (mounted.current) {
          if (isZenStaleConflict(error)) {
            try {
              const refreshed = await client.bootstrap().catch(() => null);
              if (refreshed !== null && mounted.current) setFocusZone(refreshed.focusZone);
              if (refreshed?.space !== null && refreshed?.space !== undefined) {
                if (refreshed.space.version >= optimistic.version) {
                  if (exitGate) {
                    markActive(false);
                    const safe = keepExit(refreshed.space);
                    setSpace(safe);
                    setBarCollapsedState(safe.barCollapsed);
                    presentationSpace.current = safe;
                    setMessage(
                      "Zen exit was interrupted by a newer server state. The workspace is still available.",
                    );
                  } else {
                    setSpace(refreshed.space);
                    markActive(refreshed.space.active);
                    setBarCollapsedState(refreshed.space.barCollapsed);
                    presentationSpace.current = refreshed.space;
                    setMessage("Zen presentation changed elsewhere; refreshed the current space.");
                  }
                } else if (exitGate) {
                  failExit("The server is behind the local exit state.");
                } else {
                  setMessage("Zen presentation changed elsewhere; refreshed the current space.");
                }
              } else if (exitGate) {
                failExit("The server state could not be refreshed.");
              } else {
                setSpace(previousSpace);
                markActive(previousSpace.active);
                setBarCollapsedState(previousBarCollapsed);
                presentationSpace.current = previousSpace;
                setMessage("Zen presentation changed elsewhere and could not be refreshed.");
              }
            } catch {
              if (exitGate) {
                failExit("The server state could not be refreshed.");
              } else {
                setSpace(previousSpace);
                markActive(previousSpace.active);
                setBarCollapsedState(previousBarCollapsed);
                presentationSpace.current = previousSpace;
                setMessage("Zen presentation changed elsewhere and could not be refreshed.");
              }
            }
          } else if (exitGate) {
            failExit(error instanceof Error ? error.message : "The server rejected the exit.");
          } else {
            setSpace(previousSpace);
            markActive(previousSpace.active);
            setBarCollapsedState(previousBarCollapsed);
            presentationSpace.current = previousSpace;
            setMessage(error instanceof Error ? error.message : "Zen presentation update failed.");
          }
        }
      }
    },
    [client, markActive, setBarCollapsedState, setSpace],
  );

  const processPresentationQueue = useCallback(async () => {
    while (presentationQueue.current.length > 0) {
      const item = presentationQueue.current.shift()!;
      await applyPresentation(item.next, item.exitGate);
    }
    presentationRunning.current = false;
  }, [applyPresentation]);

  const setPresentation = useCallback(
    async (
      next: { readonly active?: boolean; readonly barCollapsed?: boolean },
      options: { readonly exitGate?: boolean } = {},
    ) => {
      presentationQueue.current.push({
        next,
        ...(options.exitGate === true ? { exitGate: true } : {}),
      });
      if (!presentationRunning.current) {
        presentationRunning.current = true;
        await processPresentationQueue();
      }
    },
    [processPresentationQueue],
  );

  const loadOrCreateSpace = useCallback(async (): Promise<ZenSpace | null> => {
    if (client === undefined || windowId === undefined) {
      setMessage("Zen is unavailable for this window.");
      setRecoveryNeeded(true);
      return null;
    }

    setBusy(true);
    setMessage(undefined);
    try {
      const bootstrap = await client.bootstrap();
      if (mounted.current) setFocusZone(bootstrap.focusZone);
      if (bootstrap.space !== null) {
        if (mounted.current) {
          setSpace(bootstrap.space);
          presentationSpace.current = bootstrap.space;
          setRecoveryNeeded(false);
        }
        return bootstrap.space;
      }

      const created = await client.command({
        command: "create-space",
        windowId,
      });
      if (created.result !== "create-space") {
        throw new Error("Zen space creation failed.");
      }
      // The window's first space also opens its focus zone, and only a
      // bootstrap reports the zone, so the switcher is right from the start.
      const opened = await client.bootstrap();
      if (mounted.current) {
        setFocusZone(opened.focusZone);
        setSpace(created.space);
        presentationSpace.current = created.space;
        setRecoveryNeeded(false);
      }
      return created.space;
    } catch (error) {
      if (mounted.current) {
        setSpace(null);
        presentationSpace.current = null;
        setRecoveryNeeded(true);
        setMessage(
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : "Zen is unavailable. Recover Zen from the main workspace.",
        );
        markActive(false);
      }
      return null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client, markActive, windowId]);

  const enterZen = useCallback(async () => {
    const next = await loadOrCreateSpace();
    if (next === null || !mounted.current) return;
    if (next.active) {
      markActive(true);
      setBarCollapsedState(next.barCollapsed);
    } else {
      await setPresentation({ active: true });
    }
  }, [loadOrCreateSpace, markActive, setPresentation]);

  const exitZen = useCallback(() => {
    setMessage(undefined);
    markActive(false);
    if (presentationSpace.current?.active === true) {
      void setPresentation({ active: false }, { exitGate: true });
    }
  }, [markActive, setPresentation]);

  const recoverZen = useCallback(async () => {
    if (client === undefined || windowId === undefined) {
      setMessage("Zen recovery is unavailable for this window.");
      return;
    }

    setBusy(true);
    setMessage(undefined);
    try {
      let current = space;
      if (current === null) {
        const bootstrap = await client.bootstrap();
        if (mounted.current) setFocusZone(bootstrap.focusZone);
        current = bootstrap.space;
      }
      if (current === null) {
        const created = await client.command({ command: "create-space", windowId });
        if (created.result !== "create-space") throw new Error("Zen recovery failed.");
        const opened = await client.bootstrap();
        if (mounted.current) {
          setFocusZone(opened.focusZone);
          setSpace(created.space);
          presentationSpace.current = created.space;
          setRecoveryNeeded(false);
          markActive(true);
          setBarCollapsedState(false);
        }
        return;
      }

      await client.command({
        command: "recover",
        spaceId: current.spaceId,
        expectedVersion: current.version,
      });
      const bootstrap = await client.bootstrap();
      if (mounted.current) setFocusZone(bootstrap.focusZone);
      if (mounted.current && bootstrap.space !== null) {
        setSpace(bootstrap.space);
        presentationSpace.current = bootstrap.space;
        setRecoveryNeeded(false);
        if (bootstrap.space.active && !bootstrap.space.barCollapsed) {
          markActive(true);
          setBarCollapsedState(false);
        } else {
          await setPresentation({ active: true, barCollapsed: false });
        }
      }
    } catch (error) {
      if (mounted.current) {
        setRecoveryNeeded(true);
        markActive(false);
        setMessage(
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : "Zen recovery failed.",
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client, markActive, space, windowId]);

  const updateElement = useCallback(
    async (element: ZenElementPayload) => {
      if (client === undefined || space === null) return;
      const previous = space;
      const optimistic: ZenSpace = {
        ...space,
        elements: space.elements.map((el) => (el.elementId === element.elementId ? element : el)),
      };
      setSpace(optimistic);
      setMessage(undefined);
      try {
        const result = await client.command({
          command: "update-element",
          spaceId: space.spaceId,
          element,
          expectedVersion: space.version,
        });
        if (result.result === "mutation" && mounted.current) {
          setSpace(result.space);
        }
      } catch (error) {
        if (mounted.current) {
          if (isZenStaleConflict(error)) {
            try {
              const refreshed = await client.bootstrap();
              if (mounted.current) setFocusZone(refreshed.focusZone);
              if (refreshed.space !== null) setSpace(refreshed.space);
              setMessage("Zen changed elsewhere; refreshed the current space.");
            } catch {
              setSpace(previous);
              setMessage("Zen changed elsewhere and could not be refreshed.");
            }
            return;
          }
          setSpace(previous);
          setMessage(
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : "Zen update was rejected.",
          );
        }
      }
    },
    [client, space],
  );

  const removeElement = useCallback(
    async (elementId: ZenElementPayload["elementId"]) => {
      if (client === undefined || space === null) return;
      const previous = space;
      setSpace({
        ...space,
        elements: space.elements.filter((element) => element.elementId !== elementId),
      });
      try {
        const result = await client.command({
          command: "remove-element",
          spaceId: space.spaceId,
          elementId,
          expectedVersion: space.version,
        });
        if (result.result === "mutation" && mounted.current) setSpace(result.space);
      } catch (error) {
        if (!mounted.current) return;
        if (isZenStaleConflict(error)) {
          try {
            const refreshed = await client.bootstrap();
            if (mounted.current) setFocusZone(refreshed.focusZone);
            if (refreshed.space !== null) setSpace(refreshed.space);
            setMessage("Zen changed elsewhere; refreshed the current space.");
          } catch {
            setSpace(previous);
            setMessage("Zen changed elsewhere and could not be refreshed.");
          }
          return;
        }
        setSpace(previous);
        setMessage(
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : "Zen removal was rejected.",
        );
      }
    },
    [client, space],
  );

  const updateViewport = useCallback(
    async (viewport: ZenViewport) => {
      if (client === undefined || space === null) return;
      const previous = space;
      setSpace({ ...space, viewport });
      try {
        const result = await client.command({
          command: "update-viewport",
          spaceId: space.spaceId,
          viewport,
          expectedVersion: space.version,
        });
        if (result.result === "mutation" && mounted.current) {
          setSpace(result.space);
        }
      } catch (error) {
        if (mounted.current) {
          if (isZenStaleConflict(error)) {
            try {
              const refreshed = await client.bootstrap();
              if (mounted.current) setFocusZone(refreshed.focusZone);
              if (refreshed.space !== null) setSpace(refreshed.space);
              setMessage("Zen changed elsewhere; refreshed the current space.");
            } catch {
              setSpace(previous);
              setMessage("Zen changed elsewhere and could not be refreshed.");
            }
            return;
          }
          setSpace(previous);
          setMessage(
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : "Zen viewport update was rejected.",
          );
        }
      }
    },
    [client, space],
  );

  const refreshThreads = useCallback(
    async (query = "") => {
      if (client === undefined) {
        setMessage("Zen thread search is unavailable.");
        return;
      }
      setThreadQuery(query);
      setPanelBusy(true);
      try {
        const result = await client.searchThreads(query);
        if (mounted.current) setThreadEntries(result.entries);
      } catch (error) {
        if (mounted.current) {
          setMessage(error instanceof Error ? error.message : "Zen thread search failed.");
        }
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [client],
  );

  const openThreads = useCallback(
    async (query = "") => {
      setAssistantOpen(false);
      setThreadPickerOpen(true);
      await refreshThreads(query);
    },
    [refreshThreads],
  );

  const attachThread = useCallback(
    async (catalogRef: ZenThreadCatalogRef) => {
      if (client === undefined || space === null) return;
      setPanelBusy(true);
      try {
        const result = await client.attachThread({
          catalogRef,
          expectedVersion: space.version,
        });
        if (mounted.current) {
          setSpace(result.space);
          setThreadPickerOpen(false);
          setMessage(`Attached ${result.entry.title} from ${result.entry.projectLabel}.`);
        }
      } catch (error) {
        if (!mounted.current) return;
        if (isZenStaleConflict(error)) {
          const refreshed = await client.bootstrap().catch(() => null);
          if (refreshed !== null && mounted.current) setFocusZone(refreshed.focusZone);
          if (refreshed?.space !== null && refreshed?.space !== undefined)
            setSpace(refreshed.space);
          setMessage("Zen changed elsewhere; refreshed before attachment.");
        } else {
          setMessage(error instanceof Error ? error.message : "Zen thread attachment failed.");
        }
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [client, space],
  );

  const continueThread = useCallback(
    async (catalogRef: ZenThreadCatalogRef): Promise<ZenThreadContinuationTarget | undefined> => {
      if (client === undefined) return undefined;
      setPanelBusy(true);
      try {
        return await client.continueThread(catalogRef);
      } catch (error) {
        if (mounted.current) {
          setMessage(error instanceof Error ? error.message : "Source thread is unavailable.");
        }
        return undefined;
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [client],
  );

  const openAssistant = useCallback(async () => {
    if (client === undefined) {
      setMessage("Navigator is unavailable.");
      return;
    }
    setThreadPickerOpen(false);
    setAssistantOpen(true);
    setPanelBusy(true);
    try {
      const snapshot = await client.ensureAssistant();
      if (mounted.current) setAssistant(snapshot);
      const refreshed = await client.bootstrap().catch(() => null);
      if (refreshed !== null && mounted.current) setFocusZone(refreshed.focusZone);
      if (mounted.current && refreshed?.space !== null && refreshed?.space !== undefined) {
        setSpace(refreshed.space);
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "Navigator is unavailable.");
      }
    } finally {
      if (mounted.current) setPanelBusy(false);
    }
  }, [client]);

  /**
   * Re-read what is Zen's about the assistant surface.
   *
   * The turn itself belongs to the host's Navigator conversation, but what that
   * turn may have proposed — a recipe preview, and the space version a
   * confirmation is checked against — is Zen's, and only the host knows it. So
   * a turn sent from either Zen front is followed by this read; without it the
   * preview surface stays mounted over facts that never arrive.
   */
  const refreshAssistant = useCallback(async () => {
    if (client === undefined) return;
    try {
      const snapshot = await client.assistant();
      if (mounted.current) setAssistant(snapshot);
      const refreshed = await client.bootstrap().catch(() => null);
      if (refreshed !== null && mounted.current) setFocusZone(refreshed.focusZone);
      if (mounted.current && refreshed?.space !== null && refreshed?.space !== undefined) {
        setSpace(refreshed.space);
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "Navigator is unavailable.");
      }
    }
  }, [client]);

  const confirmRecipePreview = useCallback(
    async (action: "save" | "place") => {
      if (
        client === undefined ||
        space === null ||
        assistant?.recipePreview === undefined ||
        assistant.recipePreview === null
      ) {
        return;
      }
      setPanelBusy(true);
      try {
        const result = await client.command({
          command: "confirm-recipe-preview",
          spaceId: space.spaceId,
          previewId: assistant.recipePreview.previewId,
          action,
          expectedVersion: space.version,
        });
        if (result.result !== "mutation") throw new Error("Recipe confirmation failed.");
        if (mounted.current) {
          setSpace(result.space);
          setAssistant(await client.assistant());
          setMessage(action === "place" ? "Recipe placed in Zen." : "Recipe saved to Zen.");
        }
      } catch (error) {
        if (mounted.current) {
          setMessage(error instanceof Error ? error.message : "Recipe confirmation failed.");
          const refreshed = await client.assistant().catch(() => null);
          if (refreshed !== null) setAssistant(refreshed);
        }
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [assistant, client, space],
  );

  const updateAppearance = useCallback(
    async (patch: Partial<ZenAppearance> & Pick<ZenAppearance, "dimming" | "elementOpacity">) => {
      if (client === undefined || space === null) return;
      try {
        const result = await client.command({
          command: "update-appearance",
          spaceId: space.spaceId,
          appearance: { ...space.appearance, ...patch },
          expectedVersion: space.version,
        });
        if (result.result === "mutation" && mounted.current) setSpace(result.space);
      } catch (error) {
        if (mounted.current) {
          setMessage(error instanceof Error ? error.message : "Zen appearance update failed.");
        }
      }
    },
    [client, space],
  );

  /**
   * Pin a terminal one of this window's Code threads owns.
   *
   * The request names the shell; the card is written by the server, so nothing
   * here decides what a terminal card is allowed to be.
   */
  const pinTerminal = useCallback(
    async (request: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly terminalId: CodeTerminalId;
      readonly title?: string;
    }) => {
      if (client === undefined || space === null) return;
      setPanelBusy(true);
      try {
        const result = await client.attachTerminal({
          threadId: request.threadId,
          checkoutId: request.checkoutId,
          terminalId: request.terminalId,
          expectedVersion: space.version,
          ...(request.title === undefined ? {} : { title: request.title }),
        });
        if (mounted.current) {
          setSpace(result.space);
          presentationSpace.current = result.space;
          setMessage(undefined);
        }
      } catch (error) {
        if (mounted.current) {
          setMessage(error instanceof Error ? error.message : "That terminal could not be pinned.");
        }
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [client, space],
  );

  /**
   * Run one focus-zone command and adopt what came back.
   *
   * A space command changes which space the window is on, so the result
   * carries both the zone and the space now in front; taking them together is
   * what keeps the switcher and the surface from disagreeing.
   */
  const runSpaceCommand = useCallback(
    async (command: ZenFocusZoneCommand, failure: string) => {
      if (client === undefined) return;
      setPanelBusy(true);
      try {
        const result = await client.space(command);
        if (!mounted.current) return;
        setFocusZone(result.zone);
        setSpace(result.space);
        presentationSpace.current = result.space;
        setMessage(undefined);
      } catch (error) {
        if (mounted.current) setMessage(error instanceof Error ? error.message : failure);
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [client],
  );

  const addSpace = useCallback(
    async (name: string) => {
      if (focusZone === null) return;
      await runSpaceCommand(
        { command: "add-space", name, expectedVersion: focusZone.version },
        "This space could not be added.",
      );
    },
    [focusZone, runSpaceCommand],
  );

  const renameSpace = useCallback(
    async (spaceId: ZenSpaceId, name: string) => {
      if (focusZone === null) return;
      await runSpaceCommand(
        { command: "rename-space", spaceId, name, expectedVersion: focusZone.version },
        "This space could not be renamed.",
      );
    },
    [focusZone, runSpaceCommand],
  );

  const removeSpace = useCallback(
    async (spaceId: ZenSpaceId) => {
      if (focusZone === null) return;
      await runSpaceCommand(
        { command: "remove-space", spaceId, expectedVersion: focusZone.version },
        "This space could not be removed.",
      );
    },
    [focusZone, runSpaceCommand],
  );

  const reorderSpace = useCallback(
    async (spaceId: ZenSpaceId, position: number) => {
      if (focusZone === null) return;
      await runSpaceCommand(
        { command: "reorder-space", spaceId, position, expectedVersion: focusZone.version },
        "This space could not be moved.",
      );
    },
    [focusZone, runSpaceCommand],
  );

  const showSpace = useCallback(
    async (spaceId: ZenSpaceId) => {
      if (focusZone === null) return;
      if (String(focusZone.activeSpaceId) === String(spaceId)) return;
      await runSpaceCommand(
        { command: "activate-space", spaceId, expectedVersion: focusZone.version },
        "That space could not be shown.",
      );
    },
    [focusZone, runSpaceCommand],
  );

  /** Step one space along the switcher, wrapping at both ends. */
  const cycleSpace = useCallback(
    async (step: 1 | -1) => {
      if (focusZone === null || focusZone.spaces.length < 2) return;
      await showSpace(cycleZenSpace(focusZone, step));
    },
    [focusZone, showSpace],
  );

  const refreshTimers = useCallback(async () => {
    if (client === undefined) return;
    try {
      const bootstrap = await client.bootstrap();
      if (mounted.current) setFocusZone(bootstrap.focusZone);
      if (mounted.current && bootstrap.space !== null) setSpace(bootstrap.space);
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "Timer refresh failed.");
      }
    }
  }, [client]);

  const addTimer = useCallback(
    async (durationMs: number) => {
      if (client === undefined || space === null) return;
      setPanelBusy(true);
      try {
        const result = await client.command({
          command: "create-timer",
          spaceId: space.spaceId,
          durationMs,
          expectedVersion: space.version,
        });
        if (result.result === "mutation" && mounted.current) {
          setSpace(result.space);
          setMessage("Timer added.");
        }
      } catch (error) {
        if (!mounted.current) return;
        if (isZenStaleConflict(error)) {
          await refreshTimers();
          setMessage("Zen changed elsewhere; refreshed before adding the timer.");
        } else {
          setMessage(error instanceof Error ? error.message : "Timer creation failed.");
        }
      } finally {
        if (mounted.current) setPanelBusy(false);
      }
    },
    [client, refreshTimers, space],
  );

  const timerAction = useCallback(
    async (
      elementId: ZenElementPayload["elementId"],
      action: ZenTimerAction,
      durationMs?: number,
    ) => {
      if (client === undefined || space === null) return;
      try {
        const result = await client.command({
          command: "timer-action",
          spaceId: space.spaceId,
          elementId,
          action,
          ...(durationMs === undefined ? {} : { durationMs }),
          expectedVersion: space.version,
        });
        if (result.result === "mutation" && mounted.current) setSpace(result.space);
      } catch (error) {
        if (!mounted.current) return;
        if (isZenStaleConflict(error)) {
          await refreshTimers();
          setMessage("Zen changed elsewhere; refreshed the timer state.");
        } else {
          setMessage(error instanceof Error ? error.message : "Timer action failed.");
        }
      }
    },
    [client, refreshTimers, space],
  );

  const runWidgetCommand = useCallback(
    async (command: ZenCommand): Promise<void> => {
      if (client === undefined) throw new Error("Zen widgets are unavailable.");
      try {
        const result = await client.command(command);
        if (result.result !== "mutation") throw new Error("Zen widget mutation failed.");
        if (mounted.current) {
          setSpace(result.space);
          setMessage(undefined);
        }
      } catch (error) {
        if (mounted.current) {
          if (isZenStaleConflict(error)) {
            const refreshed = await client.bootstrap().catch(() => null);
            if (refreshed !== null && mounted.current) setFocusZone(refreshed.focusZone);
            if (refreshed?.space !== null && refreshed?.space !== undefined) {
              setSpace(refreshed.space);
              setMessage("Zen widget changed elsewhere; refreshed the saved copy.");
            } else {
              setMessage("Zen widget changed elsewhere and could not be refreshed.");
            }
          } else {
            setMessage(error instanceof Error ? error.message : "Zen widget update failed.");
          }
        }
        throw error;
      }
    },
    [client],
  );

  const createWidget = useCallback(
    async (kind: "notes" | "checklist") => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "create-widget",
        spaceId: space.spaceId,
        kind,
        expectedVersion: space.version,
      });
    },
    [runWidgetCommand, space],
  );

  const createReference = useCallback(
    async (url: string, label?: string) => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "create-reference",
        spaceId: space.spaceId,
        url: url as never,
        ...(label === undefined ? {} : { label }),
        expectedVersion: space.version,
      });
    },
    [runWidgetCommand, space],
  );

  const uploadBackground = useCallback(
    async (file: File) => {
      if (client === undefined || space === null) throw new Error("Zen background is unavailable.");
      if (
        file.type !== "image/png" &&
        file.type !== "image/jpeg" &&
        file.type !== "image/webp" &&
        file.type !== "image/gif"
      ) {
        throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
      }
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_ZEN_BACKGROUND_BYTES
      ) {
        throw new Error("Zen background is too large. Choose an image up to 8 MiB.");
      }
      const next = await client.uploadBackground({
        spaceId: space.spaceId,
        expectedVersion: space.version,
        bytes: new Uint8Array(await file.arrayBuffer()),
        mediaType: file.type,
        displayName: file.name,
      });
      if (mounted.current) setSpace(next);
    },
    [client, space],
  );

  useEffect(() => {
    const background = space?.appearance.background;
    if (client === undefined || background?.kind !== "image") {
      setBackgroundObjectUrl((current) => {
        if (current !== undefined) URL.revokeObjectURL(current);
        backgroundObjectUrlRef.current = undefined;
        return undefined;
      });
      setBackgroundStatus("ready");
      return;
    }
    let disposed = false;
    setBackgroundStatus("loading");
    void client
      .readBackground(
        background.stillAssetId !== undefined &&
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? background.stillAssetId
          : background.assetId,
      )
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        setBackgroundObjectUrl((current) => {
          if (current !== undefined) URL.revokeObjectURL(current);
          backgroundObjectUrlRef.current = url;
          return url;
        });
        setBackgroundStatus("ready");
      })
      .catch(() => {
        if (!disposed) {
          setBackgroundObjectUrl((current) => {
            if (current !== undefined) URL.revokeObjectURL(current);
            backgroundObjectUrlRef.current = undefined;
            return undefined;
          });
          setBackgroundStatus("unavailable");
        }
      });
    return () => {
      disposed = true;
    };
  }, [client, space?.appearance.background]);

  useEffect(
    () => () => {
      if (backgroundObjectUrlRef.current !== undefined) {
        URL.revokeObjectURL(backgroundObjectUrlRef.current);
        backgroundObjectUrlRef.current = undefined;
      }
    },
    [],
  );

  const saveNotes = useCallback(
    async (
      elementId: ZenElementPayload["elementId"],
      content: string,
      expectedWidgetVersion: number,
    ) => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "save-notes",
        spaceId: space.spaceId,
        elementId,
        content,
        expectedVersion: space.version,
        expectedWidgetVersion: expectedWidgetVersion as ZenSpace["version"],
      });
    },
    [runWidgetCommand, space],
  );

  const addChecklistItem = useCallback(
    async (
      elementId: ZenElementPayload["elementId"],
      text: string,
      expectedWidgetVersion: number,
    ) => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "add-checklist-item",
        spaceId: space.spaceId,
        elementId,
        text,
        expectedVersion: space.version,
        expectedWidgetVersion: expectedWidgetVersion as ZenSpace["version"],
      });
    },
    [runWidgetCommand, space],
  );

  const setChecklistItemCompleted = useCallback(
    async (
      elementId: ZenElementPayload["elementId"],
      itemId: ZenChecklistItemId,
      done: boolean,
      expectedWidgetVersion: number,
    ) => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "set-checklist-item-completed",
        spaceId: space.spaceId,
        elementId,
        itemId,
        done,
        expectedVersion: space.version,
        expectedWidgetVersion: expectedWidgetVersion as ZenSpace["version"],
      });
    },
    [runWidgetCommand, space],
  );

  const reorderChecklistItem = useCallback(
    async (
      elementId: ZenElementPayload["elementId"],
      itemId: ZenChecklistItemId,
      beforeItemId: ZenChecklistItemId | null,
      expectedWidgetVersion: number,
    ) => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "reorder-checklist-item",
        spaceId: space.spaceId,
        elementId,
        itemId,
        beforeItemId,
        expectedVersion: space.version,
        expectedWidgetVersion: expectedWidgetVersion as ZenSpace["version"],
      });
    },
    [runWidgetCommand, space],
  );

  const removeChecklistItem = useCallback(
    async (
      elementId: ZenElementPayload["elementId"],
      itemId: ZenChecklistItemId,
      expectedWidgetVersion: number,
    ) => {
      if (space === null) throw new Error("Zen space is unavailable.");
      await runWidgetCommand({
        command: "remove-checklist-item",
        spaceId: space.spaceId,
        elementId,
        itemId,
        expectedVersion: space.version,
        expectedWidgetVersion: expectedWidgetVersion as ZenSpace["version"],
      });
    },
    [runWidgetCommand, space],
  );

  const setBarCollapsed = useCallback(
    (next: boolean) => {
      if (presentationSpace.current === null) {
        setBarCollapsedState(next);
        return;
      }
      void setPresentation({ barCollapsed: next });
    },
    [setBarCollapsedState, setPresentation],
  );

  useEffect(() => {
    if (restoring.current) return;
    if (!readPresentationActive(storage, windowId)) return;
    if (client === undefined || windowId === undefined) return;
    restoring.current = true;
    void (async () => {
      try {
        const bootstrap = await client.bootstrap();
        if (mounted.current) setFocusZone(bootstrap.focusZone);
        if (!mounted.current) return;
        if (bootstrap.space !== null) {
          setSpace(bootstrap.space);
          presentationSpace.current = bootstrap.space;
          if (bootstrap.space.active) {
            markActive(true);
            setBarCollapsedState(bootstrap.space.barCollapsed);
          } else {
            markActive(false);
          }
          setRecoveryNeeded(false);
        } else {
          presentationSpace.current = null;
          markActive(false);
        }
      } catch (error) {
        if (mounted.current) {
          setMessage(error instanceof Error ? error.message : "Zen is unavailable.");
          setRecoveryNeeded(true);
          markActive(false);
        }
      } finally {
        if (mounted.current) restoring.current = false;
      }
    })();
  }, [client, markActive, setBarCollapsedState, storage, windowId]);

  return {
    active,
    space,
    pinTerminal,
    focusZone,
    addSpace,
    renameSpace,
    removeSpace,
    reorderSpace,
    showSpace,
    cycleSpace,
    busy,
    barCollapsed,
    setBarCollapsed,
    recoveryNeeded,
    message,
    enterZen,
    exitZen,
    recoverZen,
    removeElement,
    updateElement,
    updateViewport,
    threadPickerOpen,
    setThreadPickerOpen,
    threadEntries,
    threadQuery,
    panelBusy,
    openThreads,
    refreshThreads,
    attachThread,
    continueThread,
    assistantOpen,
    setAssistantOpen,
    assistant,
    openAssistant,
    refreshAssistant,
    confirmRecipePreview,
    updateAppearance,
    addTimer,
    timerAction,
    refreshTimers,
    createWidget,
    createReference,
    uploadBackground,
    backgroundObjectUrl,
    backgroundStatus,
    saveNotes,
    addChecklistItem,
    setChecklistItemCompleted,
    reorderChecklistItem,
    removeChecklistItem,
  };
}

function isZenStaleConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    (error.message.includes("stale-version") || error.message.includes("stale-widget-version"))
  );
}
