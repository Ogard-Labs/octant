import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SkillFolderSettingsPanel } from "./SkillFolderSettings";

const none = { providers: [], folders: [] } as const;

describe("SkillFolderSettingsPanel", () => {
  it("turns a provider's skill folder on and off", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SkillFolderSettingsPanel onChange={onChange} value={none} />);
    fireEvent.click(screen.getByRole("switch", { name: "Read Claude Code skills" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: ["claude"], folders: [] });
    rerender(
      <SkillFolderSettingsPanel
        onChange={onChange}
        value={{ providers: ["claude"], folders: [] }}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Read Claude Code skills" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: [], folders: [] });
  });

  it("adds an absolute folder, refuses a relative one, and removes a listed one", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SkillFolderSettingsPanel onChange={onChange} value={none} />);
    const field = screen.getByRole("textbox", { name: "Skill folder path" });
    fireEvent.change(field, { target: { value: "../skills" } });
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(screen.getByRole("alert")).toHaveTextContent("absolute folder path");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "/Users/me/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: [], folders: ["/Users/me/skills"] });

    rerender(
      <SkillFolderSettingsPanel
        onChange={onChange}
        value={{ providers: [], folders: ["/Users/me/skills"] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove /Users/me/skills" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: [], folders: [] });
  });
});
