// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { decodeCodeThreadId, decodeProjectId } from "@octant/contracts";
import { ThemeProvider } from "../../design-system/theme";
import { CoordinatorProposalsPanel } from "./CoordinatorProposalsPanel";
vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const PROJECT = "20000000-0000-4000-8000-000000000001";
const COORDINATOR = "84000000-0000-4000-8000-000000000009";

describe("a coordinator's proposals on the phone", () => {
  it("shows a pending worker with its requested level and no decision", async () => {
    const transport: MobileRemoteTransport = {
      hostId: "host-1",
      authenticatedFetch: (async () =>
        Response.json({
          designation: { kind: "none", projectId: PROJECT, updatedAt: "2026-11-10T00:00:00.000Z" },
          designationVersion: 0,
          proposals: [
            {
              proposal: {
                id: "70000000-0000-4000-8000-000000000101",
                projectId: PROJECT,
                plannerThreadId: COORDINATOR,
                fromCoordinator: true,
                title: "Fix the flaky test",
                intent: "Find and fix it.",
                status: "pending",
                proposedAt: "2026-11-10T00:00:00.000Z",
                workerOptions: { executionPolicy: "approval-gated" },
              },
              proposalVersion: 1,
            },
          ],
        })) as MobileRemoteTransport["authenticatedFetch"],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          children: createElement(CoordinatorProposalsPanel, {
            transport,
            thread: { id: decodeCodeThreadId(COORDINATOR), projectId: decodeProjectId(PROJECT) },
          }),
        }),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Fix the flaky test");
    expect(text).toContain("Requested level: Ask first or lower");
    expect(text).toContain("Approve at a window on this computer.");
    expect(container.querySelectorAll("[role=button]")).toHaveLength(0);
  });
});
