// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileHostRegistryRead } from "../hosts/HostRegistry";
import { MobileEntryGate } from "./MobileEntryGate";

interface ElementProps {
  readonly children?: ReactNode;
  readonly testID?: string;
  readonly onPress?: () => void;
}
vi.mock("react-native", () => ({
  ScrollView: (props: ElementProps) =>
    createElement("div", { "data-testid": props.testID }, props.children),
  Text: (props: ElementProps) => createElement("span", null, props.children),
  Pressable: (props: ElementProps) =>
    createElement(
      "button",
      { "data-testid": props.testID, onClick: props.onPress },
      props.children,
    ),
  ActivityIndicator: () => createElement("span", null, "Checking"),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("../../design-system", () => ({
  GlassSurface: (props: ElementProps) => createElement("section", null, props.children),
  useTheme: () => ({ colors: {} }),
  space: { lg: 24, md: 16 },
  typography: { body: { fontSize: 16 } },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function Live(props: { readonly mounted: () => void }) {
  props.mounted();
  return createElement("div", null, "Live session");
}
async function mount(readHosts: NonNullable<Parameters<typeof MobileEntryGate>[0]["readHosts"]>) {
  const mounted = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(MobileEntryGate, {
        readHosts,
        live: createElement(Live, { mounted }),
        demo: (leave) =>
          createElement(
            "button",
            { "data-testid": "leave-demo", onClick: leave },
            "Offline sample",
          ),
      }),
    ),
  );
  return { container, mounted };
}
async function click(id: string) {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  if (button === null) throw new Error("Expected entry control");
  await act(async () => button.click());
}

describe("public offline entry", () => {
  it("never mounts a live session while browsing or leaving the demo", async () => {
    const readHosts = vi.fn(async () => ({ kind: "ok" as const, hosts: [] }));
    const { container, mounted } = await mount(readHosts);
    expect(container.textContent).toContain("Explore offline demo");
    expect(mounted).not.toHaveBeenCalled();
    await click("mobile-entry-demo");
    expect(container.textContent).toContain("Offline sample");
    expect(mounted).not.toHaveBeenCalled();
    await click("leave-demo");
    expect(container.textContent).toContain("Connect a computer");
    expect(mounted).not.toHaveBeenCalled();
    expect(readHosts).toHaveBeenCalledTimes(1);
    await click("mobile-entry-connect");
    expect(mounted).toHaveBeenCalledTimes(1);
  });
  it("preserves the normal vault route for a phone with a saved computer", async () => {
    const { mounted } = await mount(async () => ({
      kind: "ok",
      hosts: [
        {
          hostId: "sample-host",
          origin: "https://example.invalid",
          label: "Computer",
          keyId: "sample-key",
          credentialGeneration: 1,
          hostKeyFingerprint: "sample-fingerprint",
        },
      ],
    }));
    expect(mounted).toHaveBeenCalledTimes(1);
  });
  it("offers the offline choice when the saved-computer list is unavailable", async () => {
    const { mounted, container } = await mount(async () => {
      throw new Error("Storage unavailable");
    });
    expect(container.textContent).toContain("Explore offline demo");
    expect(mounted).not.toHaveBeenCalled();
  });
  it("keeps the offline choice available when storage initialization fails synchronously", async () => {
    const { mounted, container } = await mount(() => {
      throw new Error("Storage initialization unavailable");
    });
    expect(container.textContent).toContain("Explore offline demo");
    expect(mounted).not.toHaveBeenCalled();
  });
  it("keeps a late host read from replacing the demo after startup times out", async () => {
    vi.useFakeTimers();
    let complete: ((value: MobileHostRegistryRead) => void) | undefined;
    const read = new Promise<MobileHostRegistryRead>((resolve) => {
      complete = resolve;
    });
    const { mounted, container } = await mount(() => read);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(container.textContent).toContain("Explore offline demo");
    await click("mobile-entry-demo");
    await act(async () =>
      complete?.({
        kind: "ok",
        hosts: [
          {
            hostId: "saved",
            origin: "https://example.invalid",
            label: "Saved computer",
            keyId: "key",
            credentialGeneration: 1,
            hostKeyFingerprint: "fingerprint",
          },
        ],
      }),
    );
    expect(container.textContent).toContain("Offline sample");
    expect(mounted).not.toHaveBeenCalled();
  });
});
