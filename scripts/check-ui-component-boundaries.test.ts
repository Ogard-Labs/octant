import { describe, expect, it } from "vitest";
import { findUiComponentBoundaryViolations } from "./check-ui-component-boundaries";

describe("UI component boundary check", () => {
  it("keeps Base UI inside the owned UI layer", () => {
    expect(
      findUiComponentBoundaryViolations({
        "apps/web/src/projects/ProjectRow.tsx":
          'import { Menu } from "@base-ui/react/menu";\nexport const value = Menu;',
      }),
    ).toEqual([
      "apps/web/src/projects/ProjectRow.tsx imports @base-ui/react outside apps/web/src/ui.",
    ]);
  });

  it("keeps shadcn recipe imports behind product adapters", () => {
    expect(
      findUiComponentBoundaryViolations({
        "apps/web/src/shell/Toolbar.tsx":
          'import { Button } from "../ui/shadcn/button";\nexport const value = Button;',
      }),
    ).toEqual(["apps/web/src/shell/Toolbar.tsx imports ui/shadcn outside apps/web/src/ui/base."]);
  });

  it("accepts recipe and adapter implementation imports", () => {
    expect(
      findUiComponentBoundaryViolations({
        "apps/web/src/ui/shadcn/button.tsx":
          'import { Button } from "@base-ui/react/button";\nexport const value = Button;',
        "apps/web/src/ui/base/OctantButton.tsx":
          'import { Button } from "../shadcn/button";\nexport const value = Button;',
      }),
    ).toEqual([]);
  });
});
