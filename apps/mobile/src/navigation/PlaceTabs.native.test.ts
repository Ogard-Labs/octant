// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import type { PlaceTabsProps } from "./PlaceTabs.types";

const native = vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: true, IS_REACT_ACT_ENVIRONMENT: true });
  return { host: undefined as undefined | Record<string, (event: object) => void> };
});

vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
  Platform: { OS: "ios", Version: "26.1", select: (choice: { ios?: unknown }) => choice.ios },
}));
vi.mock("react-native-screens", () => ({
  Tabs: {
    Host: (props: { readonly children: ReactNode } & Record<string, never>) => {
      native.host = props;
      return props.children;
    },
    Screen: (props: { readonly children?: ReactNode }) => props.children ?? null,
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: (props: { readonly children?: ReactNode }) => props.children ?? null,
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("./NewButton", () => ({ NewButton: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

let root: Root;
afterEach(() => act(() => root.unmount()));

async function render(onSelect: PlaceTabsProps["onSelect"]): Promise<void> {
  const { PlaceTabs } = await import("./PlaceTabs.native");
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(PlaceTabs, {
          active: "home",
          newHidden: false,
          newDisabled: false,
          onNew: () => undefined,
          onSelect,
          screens: {},
        }),
      }),
    ),
  );
}
const selected = (fields: object) =>
  act(async () =>
    native.host?.["onTabSelected"]?.({
      nativeEvent: {
        selectedScreenKey: "threads",
        provenance: 1,
        isRepeated: false,
        hasTriggeredSpecialEffect: false,
        actionOrigin: "user",
        ...fields,
      },
    }),
  );

it("takes a tap on the bar as the person's choice", async () => {
  const onSelect = vi.fn();
  await render(onSelect);
  await selected({});
  expect(onSelect).toHaveBeenCalledWith("threads");
});

it("does not take the bar's echo of a link it was told to open as a second tap, which would close what the link opened", async () => {
  const onSelect = vi.fn();
  await render(onSelect);
  await selected({ actionOrigin: "programmatic-js" });
  for (const actionOrigin of ["programmatic-js", "programmatic-native", "implicit"])
    await selected({ actionOrigin, selectedScreenKey: "home" });
  expect(onSelect).not.toHaveBeenCalled();
});

it("follows the bar when the system itself moved to another place", async () => {
  const onSelect = vi.fn();
  await render(onSelect);
  await selected({ actionOrigin: "programmatic-native" });
  expect(onSelect).toHaveBeenCalledWith("threads");
});

it("leaves a repeated tap to the bar when the bar already returned the place to its root", async () => {
  const onSelect = vi.fn();
  await render(onSelect);
  await selected({ isRepeated: true, hasTriggeredSpecialEffect: true });
  expect(onSelect).not.toHaveBeenCalled();
});
