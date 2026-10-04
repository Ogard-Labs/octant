import { describe, expect, it } from "vitest";
import {
  findFormValidationOwnerViolations,
  findRawControlBoundaryViolations,
  findRawControlInventory,
  findRawLiveRegionViolations,
  findUiComponentBoundaryViolations,
  findWrongAdapterBoundaryViolations,
} from "./check-ui-component-boundaries";

describe("UI component boundary check", () => {
  it("requires production forms to declare app-owned validation", () => {
    expect(
      findFormValidationOwnerViolations({
        "apps/web/src/projects/ProjectForm.tsx":
          '<form className="project-form" onSubmit={submit}><OctantInput /></form>',
        "apps/web/src/projects/ProjectForm.test.tsx": "<form><input required /></form>",
        "apps/web/src/projects/ProjectCreateDialog.tsx":
          "<form noValidate onSubmit={submit}><OctantInput /></form>",
        "apps/web/src/composer/ThreadComposer.tsx":
          "/** The enclosing <form> owns submission. */\nexport const ThreadComposer = () => null;",
      }),
    ).toEqual([
      "apps/web/src/projects/ProjectForm.tsx:1 renders an app-owned form without noValidate.",
    ]);
  });

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

  it("scopes an explicitly documented platform exception to the next control", () => {
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
        category: "ordinary",
        file: "apps/web/src/browser/BrowserWorkspace.tsx",
        line: 3,
        tag: "input",
      },
    ]);
    expect(
      findRawControlBoundaryViolations({
        "apps/web/src/browser/BrowserWorkspace.tsx":
          "/* ui-boundary-exception: native-platform-control */\n<button />\n<input />",
      }),
    ).toEqual([
      "apps/web/src/browser/BrowserWorkspace.tsx:3 renders raw <input>; import the corresponding Octant adapter.",
    ]);
  });

  it("accepts a raw control documented as a specialized editor surface", () => {
    const source =
      "{/* ui-boundary-exception: specialized-editor-surface */}\n" +
      '<button type="button" onPointerDown={handlePointerDown} />';
    expect(
      findRawControlInventory({
        "apps/web/src/apple/AppleSimulatorLiveFrame.tsx": source,
      }),
    ).toEqual([
      {
        category: "specialized-editor-surface",
        file: "apps/web/src/apple/AppleSimulatorLiveFrame.tsx",
        line: 2,
        tag: "button",
      },
    ]);
    expect(
      findRawControlBoundaryViolations({
        "apps/web/src/apple/AppleSimulatorLiveFrame.tsx": source,
      }),
    ).toEqual([]);
  });

  it("treats a native dialog as an ordinary control", () => {
    expect(
      findRawControlBoundaryViolations({
        "apps/web/src/projects/FolderPicker.tsx":
          'export function FolderPicker() { return <dialog aria-label="Add folder" />; }',
      }),
    ).toEqual([
      "apps/web/src/projects/FolderPicker.tsx:1 renders raw <dialog>; import the corresponding Octant adapter.",
    ]);
  });

  it("rejects checkbox and radio types on the text-input adapter", () => {
    expect(
      findWrongAdapterBoundaryViolations({
        "apps/web/src/code/CodeThreadBoard.tsx":
          'export function Board() { return <OctantInput type="checkbox" />;\nreturn <OctantInput type="radio" />; }',
      }),
    ).toEqual([
      'apps/web/src/code/CodeThreadBoard.tsx:1 uses OctantInput type="checkbox"; import OctantCheckbox or OctantToggleGroup.',
      'apps/web/src/code/CodeThreadBoard.tsx:2 uses OctantInput type="radio"; import OctantCheckbox or OctantToggleGroup.',
    ]);
    expect(
      findWrongAdapterBoundaryViolations({
        "apps/web/src/code/CodeThreadBoard.tsx":
          'export function Board() { return <OctantCheckbox type="checkbox" />;\nreturn <OctantInput type="search" />; }',
      }),
    ).toEqual([]);
  });

  it("rejects a JSX-string checkbox or radio type on OctantInput", () => {
    expect(
      findWrongAdapterBoundaryViolations({
        "apps/web/src/code/CodeThreadBoard.tsx":
          "export function Board() { return <OctantInput type={\"checkbox\"} />;\nreturn <OctantInput type={'radio'} />; }",
      }),
    ).toEqual([
      'apps/web/src/code/CodeThreadBoard.tsx:1 uses OctantInput type="checkbox"; import OctantCheckbox or OctantToggleGroup.',
      'apps/web/src/code/CodeThreadBoard.tsx:2 uses OctantInput type="radio"; import OctantCheckbox or OctantToggleGroup.',
    ]);
  });

  it("does not attribute a later checkbox type to OctantInput", () => {
    expect(
      findWrongAdapterBoundaryViolations({
        "apps/web/src/code/CodeThreadBoard.tsx":
          'export function Board() { return <OctantInput type="search" />;\nreturn <OctantCheckbox type="checkbox" />; }',
      }),
    ).toEqual([]);
  });

  it("rejects a raw alert outside the shared recipes", () => {
    expect(
      findRawLiveRegionViolations({
        "apps/web/src/shell/DockModuleBoundary.tsx":
          'export function Boundary() { return <p role="alert">Unavailable.</p>; }',
      }),
    ).toEqual([
      'apps/web/src/shell/DockModuleBoundary.tsx:1 renders raw role="alert" on <p>; use OctantAlert, OctantToast, OctantDialog, or OctantConfirmDialog, or record an exception.',
    ]);
  });

  it("accepts a recorded field-error exception and recipe owners", () => {
    const fieldError = [
      "export function Picker() {",
      "  return (",
      "    /* ui-boundary-exception: inline-field-error */",
      '    <p id="path-error" role="alert">Choose a folder.</p>',
      "  );",
      "}",
    ].join("\n");
    const panel = [
      "export function Picker() {",
      "  return (",
      "    /* ui-boundary-exception: non-modal-panel */",
      '    <OctantCard role="dialog" />',
      "  );",
      "}",
    ].join("\n");
    const wrappedFieldError = [
      "export function Picker() {",
      "  return (",
      "    <div>",
      "      {/* ui-boundary-exception: inline-field-error */}",
      '      <p id="path-error" role="alert">Choose a folder.</p>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(
      findRawLiveRegionViolations({
        "apps/web/src/projects/FolderPicker.tsx": fieldError,
        "apps/web/src/projects/ProjectPicker.tsx": wrappedFieldError,
        "apps/web/src/ui/base/OctantToast.tsx":
          'export function Toast() { return <div role={tone === "danger" ? "alert" : "status"} />; }',
        "apps/web/src/shell/ShellState.tsx":
          'export function ShellState() { return <OctantEmptyRoot role="alert" />; }',
        "apps/web/src/App.tsx":
          "if (document.querySelector(\"[role='dialog'], [role='menu']\") !== null) return;",
      }),
    ).toEqual([]);
    expect(
      findRawLiveRegionViolations({
        "apps/web/src/zen/ZenThreadPicker.tsx": panel,
      }),
    ).toEqual([]);
  });

  it("rejects a raw dialog that is not a recorded exception", () => {
    expect(
      findRawLiveRegionViolations({
        "apps/web/src/zen/ZenThreadPicker.tsx":
          'export function Picker() { return <OctantCard role="dialog" />; }',
      }),
    ).toEqual([
      'apps/web/src/zen/ZenThreadPicker.tsx:1 renders raw role="dialog" on <OctantCard>; use OctantAlert, OctantToast, OctantDialog, or OctantConfirmDialog, or record an exception.',
    ]);
  });
});
