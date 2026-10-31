import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerAttachButton } from "./ComposerAttachButton";

describe("Composer attachment", () => {
  it("opens the file chooser from the visible control and allows choosing the same file again", async () => {
    const user = userEvent.setup();
    const selected = vi.fn();
    render(<ComposerAttachButton onFileSelected={selected} onRefused={vi.fn()} />);
    const input = screen.getByLabelText("Choose attachment file");
    const choose = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).not.toBeVisible();
    const file = new File(["image"], "reference.png", { type: "image/png" });
    await user.upload(input, file);
    await user.upload(input, file);
    expect(selected).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenLastCalledWith(file);
  });

  it("explains a refusal without opening the chooser or accepting a stale selection", async () => {
    const user = userEvent.setup();
    const selected = vi.fn();
    const refused = vi.fn();
    render(
      <ComposerAttachButton
        onFileSelected={selected}
        onRefused={refused}
        refusedReason="Choose a model that accepts images."
      />,
    );
    const input = screen.getByLabelText("Choose attachment file");
    const choose = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    expect(refused).toHaveBeenCalledWith("Choose a model that accepts images.");
    expect(choose).not.toHaveBeenCalled();
    fireEvent.change(input, {
      target: { files: { item: () => new File(["image"], "reference.png") } },
    });
    expect(selected).not.toHaveBeenCalled();
  });
});

describe("Composer window capture", () => {
  const png = new Uint8Array([137, 80, 78, 71]);

  function installHost(host: Record<string, unknown> | undefined) {
    Object.defineProperty(window, "octantHost", { configurable: true, value: host });
  }

  afterEach(() => {
    Reflect.deleteProperty(window, "octantHost");
  });

  it("opens the file chooser directly where the host cannot capture a window", async () => {
    const user = userEvent.setup();
    render(<ComposerAttachButton onFileSelected={vi.fn()} onRefused={vi.fn()} />);
    const choose = vi.spyOn(screen.getByLabelText("Choose attachment file"), "click");
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: /Capture window/ })).toBeNull();
  });

  it("attaches a screenshot of the window the person picked, and captures nothing before the pick", async () => {
    const user = userEvent.setup();
    const captureWindow = vi.fn(async () => ({
      kind: "captured" as const,
      name: "Notes",
      mimeType: "image/png" as const,
      bytes: png,
    }));
    installHost({
      listCaptureWindows: vi.fn(async () => ({
        kind: "windows",
        windows: [
          { id: "window:1:0", name: "Notes" },
          { id: "window:2:0", name: "Mail" },
        ],
      })),
      requestCaptureWindowPermission: vi.fn(),
      captureWindow,
    });
    const selected = vi.fn();
    render(<ComposerAttachButton onFileSelected={selected} onRefused={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Capture window…" }));
    const list = await screen.findByRole("list", { name: "Open windows" });
    expect(captureWindow).not.toHaveBeenCalled();
    await user.click(within(list).getByRole("button", { name: "Notes" }));
    await waitFor(() => expect(selected).toHaveBeenCalledOnce());
    expect(captureWindow).toHaveBeenCalledExactlyOnceWith("window:1:0");
    const file = selected.mock.calls[0]?.[0] as File;
    expect(file.name).toBe("Window - Notes.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(png.byteLength);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("explains Screen Recording first and asks macOS only after the person continues", async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ kind: "permission-needed", access: "not-determined" })
      .mockResolvedValueOnce({ kind: "windows", windows: [{ id: "window:1:0", name: "Notes" }] });
    const request = vi.fn(async () => ({ kind: "granted" as const }));
    installHost({
      listCaptureWindows: list,
      requestCaptureWindowPermission: request,
      captureWindow: vi.fn(),
    });
    render(<ComposerAttachButton onFileSelected={vi.fn()} onRefused={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Capture window…" }));
    expect(
      await screen.findByText(/macOS needs your permission for Screen Recording/),
    ).toBeVisible();
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(request).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Notes" })).toBeVisible();
  });

  it("sends a person who has Screen Recording off to System Settings and attaches nothing", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async () => ({ kind: "needs-settings" as const }));
    installHost({
      listCaptureWindows: vi.fn(async () => ({ kind: "permission-needed", access: "denied" })),
      requestCaptureWindowPermission: request,
      captureWindow: vi.fn(),
    });
    const selected = vi.fn();
    render(<ComposerAttachButton onFileSelected={selected} onRefused={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Capture window…" }));
    await user.click(await screen.findByRole("button", { name: "Open System Settings" }));
    expect(await screen.findByText(/Privacy & Security > Screen Recording/)).toBeVisible();
    expect(selected).not.toHaveBeenCalled();
  });

  it("tells the person when the picked window closed instead of attaching", async () => {
    const user = userEvent.setup();
    installHost({
      listCaptureWindows: vi.fn(async () => ({
        kind: "windows",
        windows: [{ id: "window:1:0", name: "Notes" }],
      })),
      requestCaptureWindowPermission: vi.fn(),
      captureWindow: vi.fn(async () => ({ kind: "gone" })),
    });
    const selected = vi.fn();
    const refused = vi.fn();
    render(<ComposerAttachButton onFileSelected={selected} onRefused={refused} />);
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Capture window…" }));
    await user.click(await screen.findByRole("button", { name: "Notes" }));
    await waitFor(() =>
      expect(refused).toHaveBeenCalledWith("Notes closed before it could be captured."),
    );
    expect(selected).not.toHaveBeenCalled();
  });

  it("does not open the picker while the composer refuses attachments", async () => {
    const user = userEvent.setup();
    const list = vi.fn();
    installHost({
      listCaptureWindows: list,
      requestCaptureWindowPermission: vi.fn(),
      captureWindow: vi.fn(),
    });
    const refused = vi.fn();
    render(
      <ComposerAttachButton
        onFileSelected={vi.fn()}
        onRefused={refused}
        refusedReason="Choose a model that accepts images."
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Capture window…" }));
    expect(refused).toHaveBeenCalledWith("Choose a model that accepts images.");
    expect(list).not.toHaveBeenCalled();
  });
});
