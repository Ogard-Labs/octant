import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantToast } from "./OctantToast";

describe("OctantToast", () => {
  it("announces a compact notice with its details and can be dismissed by keyboard", async () => {
    const onDismiss = vi.fn();
    render(
      <OctantToast
        detail="The hand-off document for a long/project/path is ready."
        onDismiss={onDismiss}
        title="Workspace activity"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Workspace activity");
    expect(screen.getByRole("status")).toHaveTextContent("long/project/path");
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    dismiss.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("announces a danger notice immediately while keeping its message visible", () => {
    render(
      <OctantToast
        detail="The export failed."
        onDismiss={() => undefined}
        title="Export"
        tone="danger"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The export failed.");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeVisible();
  });

  it("offers a keyboard-accessible follow-up action without dismissing the notice", async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <OctantToast
        action={{ label: "Read more", onSelect: onAction }}
        detail="Restart Octant to install it."
        onDismiss={onDismiss}
        title="Update downloaded"
        tone="success"
      />,
    );

    screen.getByRole("button", { name: "Read more" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Update downloaded");
  });

  it("leaves by itself after its time, and stays while the pointer is on it", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(
        <OctantToast
          detail="Octant stopped 1 idle provider process."
          leavesAfterMs={10_000}
          onDismiss={onDismiss}
          title="Octant freed memory"
        />,
      );
      const notice = screen.getByRole("status");
      vi.advanceTimersByTime(9_000);
      fireEvent.pointerEnter(notice);
      vi.advanceTimersByTime(60_000);
      expect(onDismiss).not.toHaveBeenCalled();
      fireEvent.pointerLeave(notice);
      vi.advanceTimersByTime(9_999);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays while the keyboard is on it, even after the pointer has left", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(
        <OctantToast
          action={{ label: "View host", onSelect: () => undefined }}
          detail="Octant stopped 1 idle provider process."
          leavesAfterMs={10_000}
          onDismiss={onDismiss}
          title="Octant freed memory"
        />,
      );
      const notice = screen.getByRole("status");
      fireEvent.pointerEnter(notice);
      act(() => screen.getByRole("button", { name: /View host/ }).focus());
      fireEvent.pointerLeave(notice);
      act(() => vi.advanceTimersByTime(60_000));
      expect(onDismiss).not.toHaveBeenCalled();
      // Focus moving to the notice's other control keeps the hold.
      act(() => screen.getByRole("button", { name: "Dismiss notification" }).focus());
      act(() => vi.advanceTimersByTime(60_000));
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => screen.getByRole("button", { name: "Dismiss notification" }).blur());
      act(() => vi.advanceTimersByTime(10_000));
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays until dismissed when it is given no time to leave", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<OctantToast detail="Read this." onDismiss={onDismiss} title="Octant stopped" />);
      vi.advanceTimersByTime(600_000);
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
