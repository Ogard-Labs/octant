import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Gallery } from "./Gallery";

/**
 * The shared adapters in `ui/base` that the gallery cannot draw, each with the
 * reason. A new adapter must either appear in the gallery or be added here
 * with a reason a reviewer can accept.
 */
const NOT_SHOWN: Readonly<Record<string, string>> = {
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
  it("shows every shared adapter or says why it cannot", () => {
    const { container } = render(<Gallery />);
    const shown = new Set(
      Array.from(container.querySelectorAll("[data-adapter]"), (element) => element.textContent),
    );
    const exported = exportedAdapters();

    expect(exported.length).toBeGreaterThan(30);
    expect(exported.filter((name) => !shown.has(name) && NOT_SHOWN[name] === undefined)).toEqual(
      [],
    );
    // A name left in the list after its adapter is shown, or removed, would hide a gap later.
    expect(
      Object.keys(NOT_SHOWN).filter((name) => shown.has(name) || !exported.includes(name)),
    ).toEqual([]);
  });
});
