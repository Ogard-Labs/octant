import { describe, expect, it } from "vitest";
import {
  findRawControlBoundaryViolations,
  findRawControlInventory,
  findUiComponentBoundaryViolations,
} from "./check-ui-component-boundaries";

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

  it("reports ordinary raw controls in production feature files", () => {
    expect(
      findRawControlBoundaryViolations({
        "apps/web/src/agents/AgentPanel.tsx":
          'export function AgentPanel() { return <><button type="button">Run</button><input /></>; }',
      }),
    ).toEqual([
      "apps/web/src/agents/AgentPanel.tsx:1 renders raw <button>; import the corresponding Octant adapter.",
      "apps/web/src/agents/AgentPanel.tsx:1 renders raw <input>; import the corresponding Octant adapter.",
    ]);
  });

  it("keeps ui internals and native file inputs out of the ordinary inventory", () => {
    expect(
      findRawControlBoundaryViolations({
        "apps/web/src/ui/shadcn/input.tsx": "export const Input = () => <input />;",
        "apps/web/src/profile/ProfileEditor.tsx":
          'export const ProfileEditor = () => <input type="file" />;',
      }),
    ).toEqual([]);
    expect(
      findRawControlInventory({
        "apps/web/src/profile/ProfileEditor.tsx": '<input type="file" />',
      }),
    ).toEqual([
      {
        category: "native-file-input",
        file: "apps/web/src/profile/ProfileEditor.tsx",
        line: 1,
        tag: "input",
      },
    ]);

    const longHandler = "const value = event.currentTarget.files?.item(0);".repeat(20);
    expect(
      findRawControlBoundaryViolations({
        "apps/web/src/work/WorkComposer.tsx": `<input onChange={(event) => { ${longHandler} }} type="file" />`,
      }),
    ).toEqual([]);
  });

  it("accepts an explicitly documented platform exception without hiding ordinary controls", () => {
    expect(
      findRawControlInventory({
        "apps/web/src/browser/BrowserWorkspace.tsx":
          "/* ui-boundary-exception: native-platform-control */\n<button />\n<input />",
      }),
    ).toEqual([
      {
        category: "native-platform-control",
        file: "apps/web/src/browser/BrowserWorkspace.tsx",
        line: 2,
        tag: "button",
      },
      {
        category: "native-platform-control",
        file: "apps/web/src/browser/BrowserWorkspace.tsx",
        line: 3,
        tag: "input",
      },
    ]);
  });
});
