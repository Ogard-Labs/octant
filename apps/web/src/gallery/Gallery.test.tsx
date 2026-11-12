import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ADAPTER_ROOTS } from "./adapterRoots";
import { Gallery } from "./Gallery";

/**
 * The shared adapters in `ui/base` that the gallery cannot draw, each with the
 * reason. A new adapter must either appear in the gallery or be added here
 * with a reason a reviewer can accept.
 */
const NOT_SHOWN: Readonly<Record<string, string>> = {
  OctantDialog:
    "modal and portalled; it opens from a button in the gallery, so it is not in the page until pressed",
  OctantConfirmDialog:
    "modal and portalled; it opens from a button in the gallery, so it is not in the page until pressed",
  OctantSheet:
    "modal and portalled; it opens from a button in the gallery, so it is not in the page until pressed",
  OctantDialogPresence:
    "keeps a leaving dialog's content mounted during its exit and draws nothing itself",
  OctantContextMenuRoot:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuTrigger:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuContent:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuGroup:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuLabel:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuItem:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuCheckboxItem:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuSeparator:
    "compound part; OctantContextMenu composes it and opens only at the pointer",
  OctantContextMenuSub: "compound part; submenus open from a pointer or keyboard gesture",
  OctantContextMenuSubTrigger: "compound part; submenus open from a pointer or keyboard gesture",
  OctantContextMenuSubContent: "compound part; submenus open from a pointer or keyboard gesture",
  OctantMenuRadioGroup:
    "compound part; OctantMenu and OctantSelectField render it for their choices",
  OctantMenuRadioItem:
    "compound part; OctantMenu and OctantSelectField render it for their choices",
  OctantMenuSub: "compound part; a submenu opens from a pointer or keyboard gesture",
  OctantMenuSubPopup: "compound part; a submenu opens from a pointer or keyboard gesture",
  OctantMenuSubTrigger: "compound part; a submenu opens from a pointer or keyboard gesture",
  OctantSelectGroup: "compound part; OctantSelectField renders grouped options with it",
  OctantSelectGroupLabel: "compound part; OctantSelectField renders grouped options with it",
};

const adapterModules = import.meta.glob<Record<string, unknown>>(
  ["../ui/base/Octant*.tsx", "!../ui/base/*.test.tsx"],
  { eager: true },
);

/** The names `ui/base` exports as components, read from the modules themselves. */
function exportedAdapters(): ReadonlyArray<string> {
  return Object.values(adapterModules)
    .flatMap((module) => Object.entries(module))
    .filter(([name, value]) => /^Octant[A-Z]/.test(name) && value !== undefined)
    .map(([name]) => name)
    .sort();
}

describe("component gallery", () => {
  it("draws every shared adapter it names, or says why it cannot", () => {
    const { container } = render(<Gallery />);
    const labelled = Array.from(container.querySelectorAll<HTMLElement>("[data-adapter]"));
    // A name counts as shown only when an element its own render writes exists
    // inside the specimen that names it (or, for a portalled part, in the document).
    const drawn = new Set<string>();
    const undrawn: Array<string> = [];
    for (const label of labelled) {
      const name = label.textContent ?? "";
      const root = ADAPTER_ROOTS[name];
      const specimen = label.closest(".gallery-specimen, .gallery-states");
      const scope = root?.portalled === true ? document.body : specimen;
      if (root !== undefined && scope?.querySelector(root.selector) != null) drawn.add(name);
      else undrawn.push(name);
    }
    const exported = exportedAdapters();

    expect(exported.length).toBeGreaterThan(30);
    expect(undrawn).toEqual([]);
    expect(exported.filter((name) => !drawn.has(name) && NOT_SHOWN[name] === undefined)).toEqual(
      [],
    );
    // A name left in the list after its adapter is shown, or removed, would hide a gap later.
    expect(
      Object.keys(NOT_SHOWN).filter((name) => drawn.has(name) || !exported.includes(name)),
    ).toEqual([]);
  });

  it("leaves the app's remembered theme mode and every other stored value untouched", () => {
    localStorage.setItem("octant.theme-mode", "light");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const removals = vi.spyOn(Storage.prototype, "removeItem");
    const cookies = vi.spyOn(document, "cookie", "set");
    render(<Gallery />);

    expect(localStorage.getItem("octant.theme-mode")).toBe("light");
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    expect(cookies).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    localStorage.clear();
  });
});
