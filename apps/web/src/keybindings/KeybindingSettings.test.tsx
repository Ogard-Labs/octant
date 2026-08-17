import { fireEvent, render, renderHook, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KeybindingSettings } from "./KeybindingSettings";
import { createKeybindingStore, useKeybindings, type KeybindingStore } from "./useKeybindings";

function memoryStore(initial = ""): KeybindingStore {
  const values = new Map<string, string>();
  if (initial.length > 0) values.set("octant.keybindings.v1", initial);
  return createKeybindingStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  });
}

function renderSettings(store: KeybindingStore) {
  const hook = renderHook(() => useKeybindings(store));
  const view = render(<KeybindingSettings controller={hook.result.current} />);
  const rerender = () => view.rerender(<KeybindingSettings controller={hook.result.current} />);
  return { hook, rerender };
}

describe("KeybindingSettings", () => {
  it("records a pressed chord and puts it in the saved document", async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    const { hook, rerender } = renderSettings(store);

    const zen = screen.getByRole("button", { name: "Change the chord for Toggle Zen mode" });
    await user.click(zen);
    expect(zen).toHaveTextContent("Press a chord…");
    fireEvent.keyDown(zen, { key: "j", metaKey: true, altKey: true });

    expect(JSON.parse(hook.result.current.document)).toEqual({ "zen-mode": "Mod+Alt+J" });
    rerender();
    expect(
      screen.getByRole("button", { name: "Change the chord for Toggle Zen mode" }),
    ).toHaveTextContent(/J/);
  });

  it("starts up where reading the storage property itself throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });

    try {
      // A browser with site data blocked throws from the property, not from a
      // later call, so keybindings have to survive never reaching storage at
      // all rather than taking the whole settings surface down with them.
      expect(createKeybindingStore().getSnapshot()).toBe("");
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  it("keeps a chord for this sitting when storage refuses to persist it", async () => {
    const user = userEvent.setup();
    const refusing = createKeybindingStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage is full.");
      },
    });
    const { hook, rerender } = renderSettings(refusing);

    const zen = screen.getByRole("button", { name: "Change the chord for Toggle Zen mode" });
    await user.click(zen);
    fireEvent.keyDown(zen, { key: "j", metaKey: true, altKey: true });

    // Persistence is best-effort, but the chord the user just pressed has to
    // take effect now rather than reading back as if nothing happened.
    expect(JSON.parse(hook.result.current.document)).toEqual({ "zen-mode": "Mod+Alt+J" });
    rerender();
    expect(
      screen.getByRole("button", { name: "Change the chord for Toggle Zen mode" }),
    ).toHaveTextContent(/J/);
  });

  it("keeps a recorded chord from reaching the global handler it is naming", async () => {
    const user = userEvent.setup();
    const globalHandler = vi.fn();
    document.addEventListener("keydown", globalHandler);
    const { hook } = renderSettings(memoryStore());

    try {
      const zen = screen.getByRole("button", { name: "Change the chord for Toggle Zen mode" });
      await user.click(zen);
      fireEvent.keyDown(zen, { key: "j", metaKey: true, altKey: true });

      expect(JSON.parse(hook.result.current.document)).toEqual({ "zen-mode": "Mod+Alt+J" });
      // Naming a chord must not also run it: the window-level listeners are
      // exactly the ones the chord is being bound to.
      expect(globalHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", globalHandler);
    }
  });

  it("refuses a chord that would swallow ordinary typing and changes nothing", async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    const { hook } = renderSettings(store);

    const search = screen.getByRole("button", {
      name: "Change the chord for Find a file by name",
    });
    await user.click(search);
    fireEvent.keyDown(search, { key: "q" });

    expect(screen.getByRole("alert")).toHaveTextContent(/swallow ordinary typing/i);
    expect(hook.result.current.document).toBe("");
  });

  it("names the action that will not run when two share a chord", () => {
    renderSettings(memoryStore('{"code-file-search":"Mod+K"}'));

    expect(screen.getByRole("note")).toHaveTextContent(/Shares .* with another action/);
  });

  it("reports an override it could not apply instead of silently using the default", () => {
    renderSettings(memoryStore('{"code-file-search":"p"}'));

    expect(screen.getByRole("alert")).toHaveTextContent(/code-file-search.*Using the default/s);
  });

  it("refuses to save malformed JSON, leaving the effective chords alone", async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    const { hook } = renderSettings(store);

    fireEvent.change(screen.getByLabelText("Keybindings JSON"), { target: { value: "{oops" } });
    await user.click(screen.getByRole("button", { name: "Save JSON" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/not valid JSON/i);
    expect(hook.result.current.document).toBe("");
  });

  it("puts every action back on its default", async () => {
    const user = userEvent.setup();
    const store = memoryStore('{"zen-mode":"Mod+Alt+J"}');
    const { hook } = renderSettings(store);

    await user.click(screen.getByRole("button", { name: "Reset all to defaults" }));

    expect(hook.result.current.document).toBe("");
  });
});

describe("useKeybindings", () => {
  it("keeps one action's override when another is reset", () => {
    const store = memoryStore();
    const { result } = renderHook(() => useKeybindings(store));

    act(() => result.current.bind("zen-mode", "Mod+Alt+J"));
    act(() => result.current.bind("command-palette", "Mod+Alt+K"));
    act(() => result.current.reset("zen-mode"));

    expect(JSON.parse(result.current.document)).toEqual({ "command-palette": "Mod+Alt+K" });
  });
});
