// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { RemoveHostPanel } from "./RemoveHostPanel";

interface ShownAlert {
  readonly message: string;
  readonly buttons: ReadonlyArray<{ readonly text: string; readonly onPress?: () => void }>;
}
// The browser build shows no system alert, so the test answers it as a person would.
const alerts = vi.hoisted(() => ({ shown: [] as ShownAlert[] }));
vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
  Alert: {
    alert: (_title: string, message: string, buttons: ShownAlert["buttons"]) =>
      void alerts.shown.push({ message, buttons }),
  },
}));
// The panel reads only the theme and its sizes; the rest of the design system is native.
vi.mock("../../design-system", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/theme")),
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/tokens")),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  alerts.shown.length = 0;
  document.body.replaceChildren();
});

function show() {
  const onRemove = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(RemoveHostPanel, {
          hostLabel: "Studio Mac",
          onRemove,
          testIdSuffix: "studio",
        }),
      }),
    ),
  );
  const ask = () =>
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="mobile-host-remove-ask-studio"]')
        ?.click(),
    );
  const answer = (text: string) =>
    act(() =>
      alerts.shown
        .at(-1)
        ?.buttons.find((button) => button.text === text)
        ?.onPress?.(),
    );
  return { onRemove, ask, answer, quit: () => act(() => root.unmount()) };
}

describe("removing a computer from the phone", () => {
  it("asks first, and removes nothing when the person cancels", () => {
    const panel = show();
    panel.ask();
    expect(alerts.shown.at(-1)?.message).toContain("keeps listing this phone");
    expect(panel.onRemove).not.toHaveBeenCalled();
    panel.answer("Cancel");
    expect(panel.onRemove).not.toHaveBeenCalled();
    panel.quit();
  });

  it("removes it once the person confirms", () => {
    const panel = show();
    panel.ask();
    panel.answer("Remove");
    expect(panel.onRemove).toHaveBeenCalledTimes(1);
    panel.quit();
  });
});
