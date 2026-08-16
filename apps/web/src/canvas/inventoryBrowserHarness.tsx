import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasInventoryEntry } from "@octant/contracts";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { decodeTabGroupId } from "@octant/contracts/shell";
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspaceTab } from "./CanvasWorkspaceTab";
import { ProjectCanvasInventory } from "../projects/ProjectCanvasInventory";
import {
  canvasInventoryEntries,
  canvasInventoryProjectId,
  quarterlyCanvasId,
  quarterlyInventoryEntry,
  roadmapCanvasId,
  roadmapInventoryEntry,
} from "../projects/canvasInventoryFixtures";
import { canvasFixture } from "./test-fixtures";

const harnessGroupId = decodeTabGroupId("66666666-6666-4666-8666-666666666666");

type CanvasTab = Extract<WorkspaceTab, { readonly kind: "canvas" }>;

function createHarnessCanvasClient(): CanvasClient {
  return {
    inventory: async (_projectId, query) => {
      const normalized = query?.trim().toLowerCase() ?? "";
      const entries =
        normalized.length === 0
          ? [...canvasInventoryEntries]
          : canvasInventoryEntries.filter((entry) =>
              entry.title.toLowerCase().includes(normalized),
            );
      return { projectId: canvasInventoryProjectId, entries };
    },
    get: async (canvasId) => {
      if (canvasId === quarterlyCanvasId) {
        return {
          kind: "ready",
          version: {
            schemaVersion: CANVAS_SCHEMA_VERSION,
            canvasId: quarterlyCanvasId,
            versionId: quarterlyInventoryEntry.currentVersionId,
            sequence: quarterlyInventoryEntry.currentSequence,
            definition: canvasFixture,
            createdBy: {
              kind: "local-user",
              actorId: "88888888-8888-4888-8888-888888888888" as never,
            },
            createdAt: "2026-08-01T21:00:00.000Z" as never,
          },
        };
      }
      return {
        kind: "unavailable",
        canvasId,
        reason: "Canvas is no longer available in this Project.",
      };
    },
    history: async (canvasId) =>
      ({
        kind: "ready",
        history: {
          canvasId,
          currentVersionId: quarterlyInventoryEntry.currentVersionId,
          entries: [
            {
              versionId: quarterlyInventoryEntry.currentVersionId,
              sequence: quarterlyInventoryEntry.currentSequence,
              schemaVersion: 1,
              title: quarterlyInventoryEntry.title,
              createdAt: "2026-08-01T21:00:00.000Z" as never,
              createdBy: {
                kind: "local-user",
                actorId: "88888888-8888-4888-8888-888888888888" as never,
              },
              providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
              modelId: "octant-test-model" as never,
            },
          ],
        },
      }) as Awaited<ReturnType<CanvasClient["history"]>>,
    revise: async () =>
      ({
        kind: "denied",
        denialCode: "malformed-request",
        message: "Harness revise is not configured.",
      }) as Awaited<ReturnType<CanvasClient["revise"]>>,
    create: async () =>
      ({
        kind: "denied",
        denialCode: "unavailable",
        message: "Harness create is not configured.",
      }) as Awaited<ReturnType<CanvasClient["create"]>>,
    threadReferenceCards: async ({ mode, threadId, projectId }) => ({
      mode,
      threadId: threadId as never,
      projectId,
      cards: [],
    }),
  };
}

function tabForEntry(entry: CanvasInventoryEntry): CanvasTab {
  return {
    kind: "canvas",
    id: `tab-${String(entry.canvasId)}` as never,
    mode: entry.mode,
    title: entry.title,
    canvasId: entry.canvasId,
    projectId: entry.projectId,
  };
}

function CanvasInventoryHarness() {
  const client = useMemo(() => createHarnessCanvasClient(), []);
  const [tabs, setTabs] = useState<ReadonlyArray<CanvasTab>>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  const openCanvas = useCallback((entry: CanvasInventoryEntry) => {
    setTabs((current) => {
      const existing = current.find((tab) => tab.canvasId === entry.canvasId);
      if (existing !== undefined) {
        setActiveCanvasId(String(entry.canvasId));
        return current;
      }
      const next = [...current, tabForEntry(entry)];
      setActiveCanvasId(String(entry.canvasId));
      return next;
    });
  }, []);

  const closeActiveTab = useCallback(() => {
    if (activeCanvasId === undefined) return;
    setTabs((current) => current.filter((tab) => String(tab.canvasId) !== activeCanvasId));
    setActiveCanvasId(undefined);
  }, [activeCanvasId]);

  const reloadTabs = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const activeTab = tabs.find((tab) => String(tab.canvasId) === activeCanvasId);

  return (
    <main data-canvas-inventory-evidence="root">
      <section data-canvas-inventory-evidence="inventory">
        <ProjectCanvasInventory
          client={client}
          onOpenCanvas={openCanvas}
          projectId={canvasInventoryProjectId}
        />
      </section>
      <section data-canvas-inventory-evidence="tabs" aria-label="Canvas workspace tabs">
        <ul>
          {tabs.map((tab) => (
            <li key={String(tab.canvasId)}>
              <button
                data-canvas-tab-id={String(tab.canvasId)}
                onClick={() => setActiveCanvasId(String(tab.canvasId))}
                type="button"
              >
                {tab.title}
              </button>
            </li>
          ))}
        </ul>
        <button
          data-canvas-inventory-evidence="close-active"
          onClick={closeActiveTab}
          type="button"
        >
          Close active tab
        </button>
        <button data-canvas-inventory-evidence="reload" onClick={reloadTabs} type="button">
          Reload shell
        </button>
      </section>
      <section data-canvas-inventory-evidence="workspace" data-reload-token={reloadToken}>
        {activeTab === undefined ? (
          <p data-canvas-inventory-evidence="empty">No canvas tab selected.</p>
        ) : (
          <CanvasWorkspaceTab
            key={`${String(activeTab.canvasId)}-${reloadToken}`}
            groupId={harnessGroupId}
            tab={activeTab}
            client={client}
          />
        )}
      </section>
      <section data-canvas-inventory-evidence="unavailable">
        <CanvasWorkspaceTab
          groupId={harnessGroupId}
          tab={tabForEntry({
            ...roadmapInventoryEntry,
            title: "Missing projection row",
          })}
          client={client}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Canvas inventory browser evidence root is missing");

createRoot(root).render(
  <StrictMode>
    <CanvasInventoryHarness />
  </StrictMode>,
);
