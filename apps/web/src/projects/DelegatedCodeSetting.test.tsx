import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCodeProjectDelegatedCode } from "@octant/contracts/projects";
import { DelegatedCodeSetting } from "./DelegatedCodeSetting";

const now = () => new Date("2026-11-20T10:00:00.000Z");

describe("DelegatedCodeSetting", () => {
  it("asks the person to confirm the delivery target before the Project takes delegated Code work", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(
      <DelegatedCodeSetting
        delegatedCode={undefined}
        disabled={false}
        now={now}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("switch", { name: "Take Code work from other computers" }));
    expect(onChange).not.toHaveBeenCalled();
    const branch = screen.getByLabelText("Base branch");
    await user.clear(branch);
    await user.type(branch, "development");
    await user.click(screen.getByRole("button", { name: "Take delegated Code work" }));

    expect(onChange).toHaveBeenCalledWith({
      remoteName: "origin",
      baseBranch: "development",
      outcomeKind: "local-implementation",
      confirmedAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("says where delegated threads start and takes the mark off in one switch", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(
      <DelegatedCodeSetting
        delegatedCode={decodeCodeProjectDelegatedCode({
          remoteName: "origin",
          baseBranch: "main",
          outcomeKind: "opened-pr",
          confirmedAt: "2026-11-20T10:00:00.000Z",
        })}
        disabled={false}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByText(/start from origin\/main .* an opened pull request/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Take Code work from other computers" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("refuses a base branch longer than the target allows with a message and sends nothing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(
      <DelegatedCodeSetting
        delegatedCode={undefined}
        disabled={false}
        now={now}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("switch", { name: "Take Code work from other computers" }));
    const branch = screen.getByLabelText("Base branch");
    await user.clear(branch);
    await user.click(branch);
    await user.paste(`team/${"b".repeat(255)}`);
    expect(screen.getByText("Use a name of at most 255 characters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take delegated Code work" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
