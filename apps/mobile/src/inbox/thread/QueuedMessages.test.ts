// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageQueueSnapshot } from "@octant/contracts";
import type { RemoteSessionStanding } from "@octant/client-runtime";
import { ThemeProvider } from "../../../design-system/theme";
import {
  conversationComposerAccess,
  listMobileThreadSurfaces,
} from "../../surfaces/threadSurfacePresentation";
import { QueuedMessages } from "./QueuedMessages";
import { threadQueueActions } from "./queuedMessageRows";

vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
}));
vi.mock("../../../design-system", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../design-system/tokens")),
  ...(await vi.importActual<Record<string, unknown>>("../../../design-system/theme")),
  ...(await vi.importActual<Record<string, unknown>>("../../../design-system/tone")),
  GlassSurface: ({ children }: { readonly children?: unknown }) => children,
}));
vi.mock("@expo/vector-icons", () => ({
  Ionicons: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const queueSnapshot = {
  items: [
    {
      messageId: "00000000-0000-4000-8000-000000000301",
      status: "queued",
      revision: 1,
      createdAt: "2026-11-26T09:00:00.000Z",
      payload: { mode: "work", prompt: "Also update the docs" },
    },
    {
      messageId: "00000000-0000-4000-8000-000000000302",
      status: "dispatching",
      revision: 1,
      createdAt: "2026-11-26T09:01:00.000Z",
      payload: { mode: "work", prompt: "Run the checks next" },
    },
  ],
  paused: false,
} as never as ThreadMessageQueueSnapshot;

function renderQueue(session: RemoteSessionStanding) {
  const surfaces = listMobileThreadSurfaces({ mode: "work", session });
  const composerAccess = conversationComposerAccess(surfaces);
  const actions = threadQueueActions(
    {
      offlineDemo: false,
      composerEditable: composerAccess.editable,
      allowProductMutations: true,
    },
    {
      onEdit: vi.fn(async () => true),
      onSendNow: vi.fn(),
      onRemove: vi.fn(),
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(QueuedMessages, {
          actions,
          changing: false,
          queue: queueSnapshot,
        }),
      }),
    ),
  );
  return container;
}

describe("QueuedMessages", () => {
  it("shows queued messages without Edit, Send now, or Remove controls on a read-only pairing", () => {
    const container = renderQueue({ actsAsHostPerson: false, accessLevel: "read-only" });
    expect(container.textContent).toContain("Also update the docs");
    expect(container.textContent).toContain("Run the checks next");
    expect(container.querySelector("[data-testid^='mobile-thread-queue-edit-']")).toBeNull();
    expect(container.querySelector("[data-testid^='mobile-thread-queue-send-now-']")).toBeNull();
    expect(container.querySelector("[data-testid^='mobile-thread-queue-remove-']")).toBeNull();
  });

  it("renders Edit, Send now, and Remove only for waiting rows on a control-capable pairing", () => {
    const container = renderQueue({ actsAsHostPerson: false, accessLevel: "full" });
    expect(
      container.querySelector(
        "[data-testid='mobile-thread-queue-edit-00000000-0000-4000-8000-000000000301']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='mobile-thread-queue-send-now-00000000-0000-4000-8000-000000000301']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='mobile-thread-queue-remove-00000000-0000-4000-8000-000000000301']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='mobile-thread-queue-edit-00000000-0000-4000-8000-000000000302']",
      ),
    ).toBeNull();
  });
});
