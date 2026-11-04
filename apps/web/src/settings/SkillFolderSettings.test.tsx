import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillFolderSettingsPanel } from "./SkillFolderSettings";

const none = { providers: [], folders: [] } as const;

describe("SkillFolderSettingsPanel", () => {
  it("keeps another client's folder when settings update while the native picker is pending", async () => {
    const selected = Promise.withResolvers<string | undefined>();
    const pickFolder = () => selected.promise;
    const onChange = vi.fn(async () => true);
    const mounted = render(
      <SkillFolderSettingsPanel value={none} onChange={onChange} pickFolder={pickFolder} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    mounted.rerender(
      <SkillFolderSettingsPanel
        value={{ providers: [], folders: ["/tmp/other-client"] }}
        onChange={onChange}
        pickFolder={pickFolder}
      />,
    );
    await act(async () => selected.resolve("/tmp/selected"));
    expect(onChange).toHaveBeenCalledWith({
      providers: [],
      folders: ["/tmp/other-client", "/tmp/selected"],
    });
  });
  it("turns a provider's skill folder on and off", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SkillFolderSettingsPanel onChange={onChange} value={none} />);
    fireEvent.click(screen.getByRole("switch", { name: "Read Claude Code skills" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: ["claude"], folders: [] });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Read Claude Code skills" })).not.toBeDisabled(),
    );
    rerender(
      <SkillFolderSettingsPanel
        onChange={onChange}
        value={{ providers: ["claude"], folders: [] }}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Read Claude Code skills" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: [], folders: [] });
  });

  it("adds an absolute folder, refuses a relative one, and removes a listed one", async () => {
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
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Skill folder path" })).not.toBeDisabled(),
    );

    rerender(
      <SkillFolderSettingsPanel
        onChange={onChange}
        value={{ providers: [], folders: ["/Users/me/skills"] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove /Users/me/skills" }));
    expect(onChange).toHaveBeenLastCalledWith({ providers: [], folders: [] });
  });

  it("adds a natively selected path through the existing settings save without changing trust or enablement", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <SkillFolderSettingsPanel
        value={none}
        onChange={onChange}
        pickFolder={async () => "/tmp/selected-skills"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ providers: [], folders: ["/tmp/selected-skills"] }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /enable all/i })).toBeNull();
  });

  it("keeps manual input and explains a precise unreadable/missing root reason", () => {
    render(
      <SkillFolderSettingsPanel
        value={none}
        onChange={vi.fn()}
        statuses={[
          {
            sourceRef: "folder:first",
            displayName: "first",
            status: "missing",
            skillCount: 0,
            watching: true,
          },
          {
            sourceRef: "folder:second",
            displayName: "second",
            status: "unreadable",
            skillCount: 0,
            watching: false,
          },
        ]}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Skill folder path" })).toBeEnabled();
    expect(screen.getByText(/Folder does not exist yet/)).toBeVisible();
    expect(screen.getByText(/Folder cannot be read on this host/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
  });

  it("preserves a chosen path on rejected settings CAS and does not claim saved", async () => {
    const onChange = vi.fn(async () => false);
    render(
      <SkillFolderSettingsPanel
        value={none}
        onChange={onChange}
        pickFolder={async () => "/tmp/selected-skills"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(/folders changed elsewhere/);
    expect(screen.getByRole("textbox", { name: "Skill folder path" })).toHaveValue(
      "/tmp/selected-skills",
    );
  });

  it("ignores a late native selection after its picker connection changes", async () => {
    const selected = Promise.withResolvers<string | undefined>();
    const first = () => selected.promise;
    const onChange = vi.fn();
    const mounted = render(
      <SkillFolderSettingsPanel value={none} onChange={onChange} pickFolder={first} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    mounted.rerender(
      <SkillFolderSettingsPanel
        value={none}
        onChange={onChange}
        pickFolder={async () => undefined}
      />,
    );
    await act(async () => selected.resolve("/tmp/old-host"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
