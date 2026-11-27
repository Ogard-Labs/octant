// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRelayAddress } from "@octant/contracts";
import { ThemeProvider } from "../../design-system/theme";
import { createInMemoryMobileHostRegistryStorage } from "./HostRegistry";
import { RelayChoicePanel } from "./RelayChoicePanel";
import { createRelayChoiceStore } from "./relayChoiceStore";

vi.mock("react-native", async () => await vi.importActual("react-native-web"));
vi.mock("../../design-system", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/theme")),
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/tokens")),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ORIGIN = "https://100.101.102.103:8443";
const ADDRESS = decodeRelayAddress({
  hubMemberId: "11111111-1111-4111-8111-111111111111",
  relayUrl: "wss://hub.example.com/relay/v1",
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("the phone's choice to reach a computer through its hub", () => {
  it("is off until the person turns it on, and is kept with the address the computer told it", async () => {
    const choices = createRelayChoiceStore(createInMemoryMobileHostRegistryStorage());
    await choices.rememberAddress(ORIGIN, ADDRESS);
    expect(await choices.read(ORIGIN)).toEqual({ enabled: false, address: ADDRESS });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          children: createElement(RelayChoicePanel, {
            hostLabel: "Studio Mac",
            origin: ORIGIN,
            choices,
            testIdSuffix: "studio",
          }),
        }),
      ),
    );
    const toggle = container.querySelector<HTMLElement>(
      '[aria-label="Reach Studio Mac through the hub when away"]',
    );
    if (toggle === null) throw new Error("No relay switch.");
    expect(container.textContent).not.toContain("reaches it through its hub");
    await act(async () => toggle.click());
    await vi.waitFor(async () =>
      expect(await choices.read(ORIGIN)).toEqual({ enabled: true, address: ADDRESS }),
    );
    expect(container.textContent).toContain("reaches it through its hub");
  });

  it("forgets an address the computer no longer names, and keeps the choice itself", async () => {
    const choices = createRelayChoiceStore(createInMemoryMobileHostRegistryStorage());
    await choices.rememberAddress(ORIGIN, ADDRESS);
    await choices.setEnabled(ORIGIN, true);
    await choices.rememberAddress(ORIGIN, undefined);
    expect(await choices.read(ORIGIN)).toEqual({ enabled: true });
    await choices.forget(ORIGIN);
    expect(await choices.read(ORIGIN)).toBeUndefined();
  });
});
