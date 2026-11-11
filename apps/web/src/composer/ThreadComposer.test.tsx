import type { ContextClient } from "@octant/client-runtime/context-client";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { decodeProviderUsageLimitsSnapshot } from "@octant/contracts";
import { decodeThreadExternalContentState } from "@octant/contracts/content-provenance";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OutsideContentContext } from "./OutsideContentNotice";
import { PlanUsageProvider } from "../usage/PlanUsageContext";
import { FrozenBarScope } from "./frozenBarScope";
import { ThreadComposer } from "./ThreadComposer";

describe("ThreadComposer", () => {
  it("keeps attach, the prompt and send in the card and the thread's controls in the row under it", () => {
    const { container } = render(
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        row={{
          attach: <button type="button">Attach</button>,
          leading: <span>Access</span>,
          trailing: <span>Model</span>,
          actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } },
        }}
      />,
    );
    const card = container.querySelector(".thread-composer__surface");
    const row = container.querySelector(".composer-row");
    // The card holds what acts on the message being written, in reading
    // order: attach, the prompt, send.
    const field = container.querySelector(".composer-field");
    expect(card).toContainElement(field as HTMLElement);
    expect([...(field?.children ?? [])].map((child) => child.className)).toEqual([
      "composer-field__attach",
      "composer-field__prompt",
      "composer-field__actions",
    ]);
    expect(field?.children[0]).toContainElement(screen.getByRole("button", { name: "Attach" }));
    expect(field?.children[1]).toContainElement(screen.getByRole("textbox", { name: "Message" }));
    expect(field?.children[2]).toContainElement(screen.getByRole("button", { name: "Send" }));
    // How the thread runs stands on the page under the card, access leading
    // and the model trailing.
    expect(card?.nextElementSibling).toBe(row?.parentElement);
    expect(row?.parentElement).toHaveClass("composer-under");
    expect(row).toContainElement(screen.getByText("Access"));
    expect(row).not.toContainElement(screen.getByRole("button", { name: "Send" }));
    const trailing = container.querySelector(".composer-actions");
    expect(trailing).toContainElement(screen.getByText("Model"));
    expect(trailing).not.toContainElement(screen.getByText("Access"));
  });

  it("draws send as a quiet tile until there is something to send, then as the card's one solid control", () => {
    const { rerender } = render(
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        row={{
          actions: { kind: "send", send: { ariaLabel: "Send", disabled: true, onSend: vi.fn() } },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    rerender(
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("data-variant", "solid");
  });

  it("puts the plan meters at the right of the start screen's context row", async () => {
    const providerInstanceId = "10000000-0000-4000-8000-000000000001";
    const observedAt = "2026-10-20T12:00:00.000Z";
    const window = (id: string, utilization: number) => ({
      window: id,
      status: "allowed",
      utilization,
      observedAt,
    });
    const snapshot = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: observedAt,
      entries: [
        {
          providerInstanceId,
          status: "available",
          source: "provider-runtime",
          observedAt,
          limits: {
            providerInstanceId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "observed-evidence",
            confidence: "high",
            updatedAt: observedAt,
            rateLimitWindows: [window("five_hour", 0.15), window("seven_day", 0.57)],
          },
        },
      ],
    });
    const client = { list: vi.fn(async () => snapshot) } as unknown as ProviderUsageLimitsClient;
    const { container } = render(
      <PlanUsageProvider barStyle="smooth" client={client}>
        <ThreadComposer
          input={<textarea aria-label="Message" className="composer-input" />}
          planUsage={{ providerInstanceId }}
          row={{
            actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } },
          }}
          startContext={<div className="composer-tray composer-tray--start">Project</div>}
        />
      </PlanUsageProvider>,
    );

    const meters = await screen.findByRole("group", { name: "Plan usage left" });
    const row = container.querySelector(".composer-start");
    expect(row).toContainElement(meters);
    expect(row?.firstElementChild).toHaveClass("composer-tray");
    expect(row?.lastElementChild).toBe(meters);
    expect(meters).toHaveTextContent("5h85%week43%");
  });

  it("says a notice in a card above the pill and keeps the checkout context in the row under it", () => {
    const row = {
      actions: { kind: "send" as const, send: { ariaLabel: "Send", onSend: vi.fn() } },
    };
    const input = (
      <textarea aria-label="Message" defaultValue="Keep my draft" className="composer-input" />
    );
    const context = <span>Project · branch</span>;
    const { container, rerender } = render(
      <ThreadComposer
        presentation="follow-up"
        context={context}
        input={input}
        row={row}
        notices={[{ key: "usage", tone: "warning", text: "Usage notice" }]}
      />,
    );
    const field = screen.getByRole("textbox", { name: "Message" });
    const surface = container.querySelector(".thread-composer__surface");
    const cards = container.querySelector(".composer-notices");
    const under = container.querySelector(".composer-under");
    expect(surface).toContainElement(field);
    // The pill holds the message and nothing said about it: the notice is a
    // card of its own, directly above the pill.
    const card = within(cards as HTMLElement).getByText("Usage notice");
    expect(surface).not.toContainElement(card);
    expect(cards?.nextElementSibling).toBe(surface);
    expect(card.closest(".callout")).toHaveAttribute("data-tone", "warning");
    // The line under the pill holds the checkout context.
    expect(surface?.nextElementSibling).toBe(under);
    expect(under).toContainElement(container.querySelector(".thread-composer__context"));
    // The context is beside the surface's row, not in it: the row restyles
    // every control inside it, and the checkout's actions keep their own.
    expect(container.querySelector(".composer-row")).not.toContainElement(
      container.querySelector(".thread-composer__context"),
    );
    rerender(<ThreadComposer presentation="follow-up" context={context} input={input} row={row} />);
    expect(container.querySelector(".composer-notices")).toBe(cards);
    expect(cards).toBeEmptyDOMElement();
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(field);
    expect(field).toHaveValue("Keep my draft");
  });

  it("stacks several notices as separate cards, the most severe first, and announces a refusal as an alert", () => {
    const { container } = render(
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
        notices={[
          {
            key: "hint",
            tone: "neutral",
            text: "A hint",
            action: <button type="button">Do it</button>,
          },
          { key: "note", tone: "neutral", text: "A plain note" },
          { key: "warn", tone: "warning", text: "A warning" },
          { key: "fail", tone: "danger", role: "alert", text: "A refusal" },
        ]}
      />,
    );
    const cards = [...(container.querySelector(".composer-notices")?.children ?? [])];
    expect(cards.map((card) => card.getAttribute("data-tone"))).toEqual([
      "danger",
      "warning",
      "neutral",
    ]);
    // A refusal, a warning and an offer with an action are alerts, in this order.
    expect(
      screen.getAllByRole("alert").map((alert) => alert.textContent?.replace("Do it", "")),
    ).toEqual(["A refusal", "A warning", "A hint"]);
    // A plain note with no action is never a card: it is the quiet line.
    expect(container.querySelector(".composer-progress__line")).toHaveTextContent("A plain note");
    expect(
      container.querySelector(".thread-composer__surface")?.querySelector(".callout"),
    ).toBeNull();
  });

  it("says passing progress in one quiet line that takes no room and never mounts a card", () => {
    const base = {
      input: <textarea aria-label="Message" className="composer-input" />,
      row: { actions: { kind: "send" as const, send: { ariaLabel: "Send", onSend: vi.fn() } } },
    };
    const { container, rerender } = render(<ThreadComposer {...base} />);
    // The region is always mounted, so its first announcement is never lost.
    const region = container.querySelector(".composer-progress") as HTMLElement;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelector(".composer-progress__line")).toBeNull();

    rerender(<ThreadComposer {...base} progress={{ text: "Sending message…" }} />);
    expect(container.querySelector(".composer-progress")).toBe(region);
    expect(region.querySelector(".composer-progress__line")).toHaveTextContent("Sending message…");
    // Progress is never a card: the notice group stays empty and the pill is
    // the same element in the same place.
    expect(container.querySelector(".composer-notices")).toBeEmptyDOMElement();

    // A control that already says it leaves no visible line, only the region.
    rerender(
      <ThreadComposer {...base} progress={{ text: "Response is streaming.", quiet: true }} />,
    );
    expect(region.querySelector(".composer-progress__line")).toBeNull();
    expect(region).toHaveTextContent("Response is streaming.");
  });

  it("describes the prompt by the status region and by a pending refusal, and announces a refusal once", () => {
    const base = {
      input: <textarea aria-label="Message" className="composer-input" aria-describedby="own" />,
      row: { actions: { kind: "send" as const, send: { ariaLabel: "Send", onSend: vi.fn() } } },
    };
    const refusal = { key: "refusal", tone: "danger" as const, text: "Nothing was sent." };
    const fact = { key: "fact", tone: "neutral" as const, text: "Files were restored." };
    const { container, rerender } = render(
      <ThreadComposer {...base} description="Enter a message first." notices={[refusal, fact]} />,
    );
    const prompt = screen.getByRole("textbox", { name: "Message" });
    const alert = screen.getByRole("alert");
    const region = container.querySelector(".composer-progress") as HTMLElement;
    expect(alert).toHaveTextContent("Nothing was sent.");
    // Its own description stays, then the region, then the refusal card.
    expect(prompt.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "own",
      region.id,
      alert.id,
    ]);
    expect(prompt).toHaveAccessibleDescription(/Enter a message first\..*Nothing was sent\./);
    // A plain note is said in the region, where it is announced, and never in
    // a card.
    expect(region).toHaveTextContent("Files were restored.");
    expect(container.querySelector(".composer-notices")?.children).toHaveLength(1);
    // A re-render keeps the same alert element: it is announced once.
    rerender(
      <ThreadComposer {...base} description="Enter a message first." notices={[refusal, fact]} />,
    );
    expect(screen.getByRole("alert")).toBe(alert);
    // Once resolved, the refusal leaves the description.
    rerender(<ThreadComposer {...base} notices={[fact]} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(prompt.getAttribute("aria-describedby")?.split(" ")).toEqual(["own", region.id]);
  });

  it("draws a notice's action at the card's trailing edge, after its words, and keeps the pill clear", async () => {
    const onUndo = vi.fn();
    const { container } = render(
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: onUndo } } }}
        notices={[
          {
            key: "restore",
            tone: "neutral",
            text: "Files were restored.",
            action: <button type="button">Undo restore</button>,
          },
        ]}
      />,
    );
    const card = container.querySelector(".composer-notices .callout");
    expect(card?.lastElementChild).toHaveClass("callout__actions");
    expect(card?.querySelector(".callout__body")).toHaveTextContent("Files were restored.");
    expect(card).toContainElement(screen.getByRole("button", { name: "Undo restore" }));
    expect(container.querySelector(".thread-composer__surface")).not.toContainElement(
      screen.getByRole("button", { name: "Undo restore" }),
    );
  });

  it("offers the outside-content review from a chip in the row under a marked thread's pill and holds the clear while the thread is busy", async () => {
    const threadId = "40000000-0000-4000-8000-000000000001";
    const marked = decodeThreadExternalContentState({
      threadId,
      externalContentIngested: true,
      version: 1,
      ingestionCount: 1,
      sources: [{ sourceLabel: "web-fetch", ingestionCount: 1 }],
    });
    const client = {
      externalContentAvailable: true,
      readExternalContent: vi.fn(async () => marked),
      clearExternalContent: vi.fn(),
    } as unknown as ContextClient;
    const { container } = render(
      <OutsideContentContext value={{ client, mode: "work", threadId }}>
        <ThreadComposer
          presentation="follow-up"
          threadBusy
          input={<textarea aria-label="Message" className="composer-input" />}
          row={{
            leading: <button type="button">Ask first</button>,
            actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } },
          }}
        />
      </OutsideContentContext>,
    );

    const chip = await screen.findByRole("button", { name: "Outside content" });
    // The chip stands in the row under the pill, right after the access
    // control; no card stands above the pill and nothing of it is in the pill.
    const surface = container.querySelector(".thread-composer__surface");
    const row = container.querySelector(".composer-row");
    expect(surface).not.toContainElement(chip);
    expect(row).toContainElement(chip);
    expect(row?.firstElementChild).toBe(screen.getByRole("button", { name: "Ask first" }));
    expect(screen.getByRole("button", { name: "Ask first" }).nextElementSibling).toContainElement(
      chip,
    );
    expect(container.querySelector(".composer-notices")).toBeEmptyDOMElement();
    const user = userEvent.setup();
    await user.click(chip);
    await user.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Clear the mark" })).toBeDisabled();
    await waitFor(() => expect(client.readExternalContent).toHaveBeenCalled());
  });

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
    expect(container.querySelector(".composer-field__attach")).toBeNull();
    // The composer is its frame alone, and the frame holds the notice cards
    // (none here, so the group is empty and takes no room), the pill and the
    // line under it.
    expect(frame?.children).toHaveLength(1);
    const inner = frame?.children[0];
    expect(inner).toHaveClass("composer-frame");
    // The always-mounted status region comes first; it takes no layout room.
    expect(inner?.children).toHaveLength(4);
    expect(inner?.children[0]).toBe(container.querySelector(".composer-progress"));
    expect(inner?.children[1]).toBe(container.querySelector(".composer-notices"));
    expect(inner?.children[1]).toBeEmptyDOMElement();
    expect(inner?.children[2]).toBe(container.querySelector(".thread-composer__surface"));
    expect(inner?.children[2]).toContainElement(screen.getByRole("textbox", { name: "Message" }));
    expect(inner?.children[3]).toBe(container.querySelector(".composer-under"));
    expect(inner?.children[3]?.children).toHaveLength(1);
    expect(inner?.children[3]?.children[0]).toBe(container.querySelector(".composer-row"));
  });

  it("keeps the message label a direct child of the prompt cell so the input stays full width", () => {
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

    // `.composer-field__prompt > label { display: block }` is what gives the
    // content-sized textarea a full-width box; an inline label once
    // shrink-wrapped the input to the typed text. The rule only applies while
    // the label stays a direct child of the prompt cell, so that structure is
    // the contract.
    const label = container.querySelector("label.surface__message-field");
    expect(label).not.toBeNull();
    expect(label?.parentElement).toBe(container.querySelector(".composer-field__prompt"));
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

  it("keeps the thread's info reachable, and what a person typed into it, while a move holds the thread", async () => {
    const user = userEvent.setup();
    const composer = (
      <ThreadComposer
        info={<input aria-label="Cloud task" />}
        input={<textarea aria-label="Message" className="composer-input" />}
        presentation="follow-up"
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
      />
    );
    const { rerender } = render(
      <FrozenBarScope.Provider value={undefined}>{composer}</FrozenBarScope.Provider>,
    );
    await user.type(screen.getByRole("textbox", { name: "Cloud task" }), "Draft a report");

    rerender(
      <FrozenBarScope.Provider value={<p>Moving to another computer</p>}>
        {composer}
      </FrozenBarScope.Provider>,
    );

    expect(screen.getByText("Moving to another computer")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    // The same field, not a new one: a move that starts and is cancelled must
    // not discard a task the person was reviewing.
    expect(screen.getByRole("textbox", { name: "Cloud task" })).toHaveValue("Draft a report");

    rerender(<FrozenBarScope.Provider value={undefined}>{composer}</FrozenBarScope.Provider>);

    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Cloud task" })).toHaveValue("Draft a report");
  });
});
