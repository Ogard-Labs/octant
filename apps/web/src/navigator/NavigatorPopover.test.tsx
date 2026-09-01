import type { NavigatorAssistantSnapshot } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantButton } from "../ui/base/OctantButton";
import { NavigatorPopover } from "./NavigatorPopover";
import { useNavigatorAssistant } from "./useNavigatorAssistant";

function snapshot(): NavigatorAssistantSnapshot {
  return {
    status: "ready",
    settingsTarget: { section: "navigator-assistant", setting: "default-model" },
    threadId: null,
    transcript: [],
    defaultProvider: {
      providerInstanceId: "00000000-0000-4000-8000-00000000b001",
      modelId: "model-a",
    },
    imageInput: "supported",
    visionReviewer: null,
  } as unknown as NavigatorAssistantSnapshot;
}

function Harness(props: {
  readonly onClose: () => void;
  readonly onOpenSettings: (target: { readonly section: string }) => void;
  readonly open: boolean;
  readonly restoreFocus?: React.RefObject<HTMLButtonElement | null>;
  readonly snapshot?: NavigatorAssistantSnapshot;
}) {
  const controller = useNavigatorAssistant({
    snapshot: async () => props.snapshot ?? snapshot(),
    execute: async () => ({ kind: "message-sent", snapshot: props.snapshot ?? snapshot() }),
  });
  return (
    <NavigatorPopover
      controller={controller}
      onClose={props.onClose}
      onOpenSettings={props.onOpenSettings}
      open={props.open}
      {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
    />
  );
}

describe("NavigatorPopover", () => {
  it("opens as an app-wide dialog and restores focus without needing a Project", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <>
        <OctantButton ref={opener} type="button">
          Profile
        </OctantButton>
        <Harness onClose={onClose} onOpenSettings={vi.fn()} open restoreFocus={opener} />
      </>,
    );

    expect(await screen.findByRole("dialog", { name: "Navigator" })).toHaveAttribute(
      "id",
      "navigator-popover",
    );
    expect(screen.getByText("Running on model-a")).toBeVisible();
    expect(screen.getByLabelText("Message Navigator")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    rerender(
      <>
        <OctantButton ref={opener} type="button">
          Profile
        </OctantButton>
        <Harness onClose={onClose} onOpenSettings={vi.fn()} open={false} restoreFocus={opener} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Profile" })).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Navigator" })).not.toBeInTheDocument();
  });

  it("offers the Settings fix when Navigator has no default model", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <Harness
        onClose={vi.fn()}
        onOpenSettings={onOpenSettings}
        open
        snapshot={{
          ...snapshot(),
          status: "unconfigured",
          defaultProvider: null,
        }}
      />,
    );

    expect(await screen.findByText("Navigator has no default model")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Navigator settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "navigator-assistant",
      setting: "default-model",
    });
  });
});
