import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadComposer } from "./ThreadComposer";

describe("ThreadComposer", () => {
  it("renders only the capabilities the surface passes in", () => {
    const { container } = render(
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
      />,
    );

    const frame = container.querySelector(".composer");
    expect(frame).not.toBeNull();
    // A surface that offers no chips, typeahead, label, or status gets none of
    // their markup — no empty rows or labels for capabilities it lacks.
    expect(container.querySelector("label")).toBeNull();
    expect(frame?.children).toHaveLength(2);
    expect(frame?.children[0]).toBe(screen.getByRole("textbox", { name: "Message" }));
    expect(frame?.children[1]).toBe(container.querySelector(".composer-row"));
  });

  it("keeps the message label a direct child of the frame so the input stays full width", () => {
    const { container } = render(
      <ThreadComposer
        label={{
          className: "surface__message-field",
          text: "Message",
          textClassName: "surface__visually-hidden",
        }}
        input={<textarea className="composer-input" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
      />,
    );

    // `.composer > label { display: block }` is what gives the content-sized
    // textarea a full-width box; an inline label once shrink-wrapped the input
    // to the typed text. The rule only applies while the label stays a direct
    // child of the frame, so that structure is the contract.
    const label = container.querySelector("label.surface__message-field");
    expect(label).not.toBeNull();
    expect(label?.parentElement).toBe(container.querySelector(".composer"));
    expect(label?.querySelector("textarea.composer-input")).not.toBeNull();
  });

  it("refuses to send while a disabled reason stands and sends once it clears", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { rerender } = render(
      <ThreadComposer
        input={<textarea className="composer-input" />}
        row={{
          actions: {
            kind: "send",
            send: { ariaLabel: "Send", disabledReason: "Enter a message first.", onSend },
          },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    rerender(
      <ThreadComposer
        input={<textarea className="composer-input" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend } } }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows stop alongside send while a response streams, honors the stop disabled reason, and hides stop once idle", () => {
    const stop = { ariaLabel: "Stop response", onStop: vi.fn() };
    const send = { ariaLabel: "Send message", onSend: vi.fn() };
    const { rerender } = render(
      <ThreadComposer
        input={<textarea className="composer-input" />}
        row={{
          actions: {
            kind: "send-or-stop",
            cellClassName: "surface__actions",
            sending: true,
            send,
            stop,
          },
        }}
      />,
    );

    // Send stays available while a response streams: a message written then is
    // sent, so the control that sends it must never go away.
    expect(screen.getByRole("button", { name: "Stop response" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    rerender(
      <ThreadComposer
        input={<textarea className="composer-input" />}
        row={{
          actions: {
            kind: "send-or-stop",
            cellClassName: "surface__actions",
            sending: true,
            send,
            stop: { ...stop, disabledReason: "Stopping is unavailable for this response." },
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop response" })).toBeDisabled();

    rerender(
      <ThreadComposer
        input={<textarea className="composer-input" />}
        row={{
          actions: {
            kind: "send-or-stop",
            cellClassName: "surface__actions",
            sending: false,
            send,
            stop,
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
  });

  it("submits the surrounding form when the surface owns submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form noValidate onSubmit={onSubmit}>
        <ThreadComposer
          input={<textarea className="composer-input" />}
          row={{ actions: { kind: "send", send: { ariaLabel: "Start thread" } } }}
        />
      </form>,
    );

    const send = screen.getByRole("button", { name: "Start thread" });
    expect(send).toHaveAttribute("type", "submit");
    await user.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
