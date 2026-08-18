import type {
  ZenBootstrapResponse,
  ZenCommand,
  ZenResult,
  ZenSpace,
  ZenSpaceId,
} from "@octant/contracts/zen";
import { DEFAULT_ZEN_APPEARANCE, DEFAULT_ZEN_VIEWPORT } from "@octant/contracts/zen";
import type { AggregateVersion } from "@octant/contracts/events";
import { decodeWindowId } from "@octant/contracts/shell";
import type { ZenClient } from "@octant/client-runtime/zen-client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZenRoot } from "./ZenRoot";
import { ZenSurface } from "./ZenSurface";
import { useZenController } from "./useZenController";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000921");
const spaceId = "00000000-0000-4000-8000-000000000922" as ZenSpaceId;

function makeSpace(overrides: Partial<ZenSpace> = {}): ZenSpace {
  return {
    spaceId,
    windowId,
    version: 1 as AggregateVersion,
    elements: [],
    viewport: DEFAULT_ZEN_VIEWPORT,
    appearance: DEFAULT_ZEN_APPEARANCE,
    active: false,
    barCollapsed: false,
    assistant: null,
    createdAt: "2026-07-26T12:00:00.000Z" as ZenSpace["createdAt"],
    updatedAt: "2026-07-26T12:00:00.000Z" as ZenSpace["updatedAt"],
    ...overrides,
  };
}

function Harness(props: { readonly client: ZenClient }) {
  const zen = useZenController({
    client: props.client,
    windowId,
    storage: window.sessionStorage,
  });

  return (
    <ZenRoot
      active={zen.active}
      onExit={zen.exitZen}
      onToggle={() => {
        if (zen.active) zen.exitZen();
        else void zen.enterZen();
      }}
      zen={
        zen.space === null ? (
          <div>Opening Zen…</div>
        ) : (
          <ZenSurface
            barCollapsed={zen.barCollapsed}
            onExit={zen.exitZen}
            onExpandBar={() => zen.setBarCollapsed(false)}
            onHideBar={() => zen.setBarCollapsed(true)}
            onUpdateElement={(element) => void zen.updateElement(element)}
            onUpdateViewport={(viewport) => void zen.updateViewport(viewport)}
            space={zen.space}
          />
        )
      }
    >
      <div>
        <button onClick={() => void zen.enterZen()} type="button">
          Open Zen
        </button>
        <span data-testid="shell-mode">code</span>
        <span data-testid="shell-project">Octant</span>
        <span data-testid="shell-tab">Controller foundation</span>
      </div>
    </ZenRoot>
  );
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("Zen takeover shell restore", () => {
  it("restores the ordinary shell markers after Exit Zen", async () => {
    const client: ZenClient = {
      bootstrap: vi.fn(
        async (): Promise<ZenBootstrapResponse> => ({ space: null, focusZone: null, windowId }),
      ),
      command: vi.fn(async (cmd: ZenCommand): Promise<ZenResult> => {
        if (cmd.command === "create-space") {
          return { result: "create-space", space: makeSpace({ active: true }) };
        }
        if (cmd.command === "set-presentation") {
          return {
            result: "mutation",
            space: makeSpace({
              active: typeof cmd.active === "boolean" ? cmd.active : false,
              barCollapsed: typeof cmd.barCollapsed === "boolean" ? cmd.barCollapsed : false,
            }),
          };
        }
        return { result: "mutation", space: makeSpace() };
      }),
      space: vi.fn() as never,
      attachTerminal: vi.fn() as never,
      searchThreads: vi.fn() as never,
      attachThread: vi.fn() as never,
      continueThread: vi.fn() as never,
      assistant: vi.fn() as never,
      ensureAssistant: vi.fn() as never,
      uploadBackground: vi.fn() as never,
      readBackground: vi.fn() as never,
    };

    render(<Harness client={client} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Zen" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("application", { name: "Zen workspace" })).toBeInTheDocument();
    });
    expect(screen.getByTestId("shell-mode").closest(".zen-root__shell")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Exit Zen" }));

    expect(screen.queryByRole("application", { name: "Zen workspace" })).not.toBeInTheDocument();
    expect(screen.getByTestId("shell-mode")).toHaveTextContent("code");
    expect(screen.getByTestId("shell-project")).toHaveTextContent("Octant");
    expect(screen.getByTestId("shell-tab")).toHaveTextContent("Controller foundation");
  });
});
