import { decodeCanvasBlock, type CanvasChoiceBlock } from "@octant/contracts/canvas";
import {
  decodeCanvasActor,
  type CanvasChoiceAnswersReviseCommand,
  type CanvasChoiceAnswersReviseResult,
} from "@octant/contracts";
import {
  EMPTY_CANVAS_CHOICE_ANSWER_STATE,
  canvasChoiceQuestionFingerprint,
  admitCanvasChoiceAnswersRevision,
  applyCanvasChoiceAnswerEvent,
} from "@octant/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { canvasDecisionFormMessage } from "./../canvasChoiceMessage";
import { ChoiceBlock, type CanvasChoiceAnswersPort, type CanvasChoiceRuntime } from "./ChoiceBlock";

const canvasId = "11111111-1111-4111-8111-111111111111";
const person = decodeCanvasActor({
  kind: "local-user",
  actorId: "22222222-2222-4222-8222-222222222222",
});

const yesNo = (id: string, prompt: string, recommended = true) => ({
  id,
  prompt,
  selection: "single" as const,
  options: [
    { id: "yes", label: "Yes", ...(recommended ? { recommended: true } : {}) },
    { id: "no", label: "No" },
  ],
});
const form = decodeCanvasBlock({
  blockId: "decisions",
  schemaVersion: 29,
  kind: "choice",
  prompt: "Full access decisions",
  questions: [
    yesNo("who", "Who may set it?"),
    yesNo("reach", "How far does it reach?"),
    yesNo("agents", "May an agent hold it?", false),
    { ...yesNo("skip", "Anything else?", false), minSelections: 0 },
  ],
  sections: [
    { id: "access", title: "Access", intro: "Who and how far", questionIds: ["who", "reach"] },
    { id: "agents", title: "Agents", questionIds: ["agents", "skip"] },
  ],
}) as CanvasChoiceBlock;

/** A host that admits answers with the real policy, as the server does. */
function host(options: { readonly refuse?: string } = {}) {
  let state = EMPTY_CANVAS_CHOICE_ANSWER_STATE;
  const revise = vi.fn(
    async (command: CanvasChoiceAnswersReviseCommand): Promise<CanvasChoiceAnswersReviseResult> => {
      if (options.refuse !== undefined) {
        return { kind: "denied", denialCode: "invalid-answer", message: options.refuse };
      }
      const admitted = admitCanvasChoiceAnswersRevision(
        command,
        { blocks: [form] },
        state,
        person,
        "2026-11-12T10:00:00.000Z" as never,
      );
      if (admitted.kind === "rejected") {
        return { kind: "denied", denialCode: admitted.code, message: admitted.message };
      }
      state = admitted.events.reduce(applyCanvasChoiceAnswerEvent, state);
      return { kind: "accepted", canvasId: command.canvasId, sequence: state.sequence };
    },
  );
  const port = {
    canvasId: canvasId as never,
    load: async () => ({
      kind: "ready" as const,
      canvasId: canvasId as never,
      sequence: state.sequence,
      answers: state.answers,
    }),
    revise,
  };
  return { port, revise };
}

const sendable = (port: CanvasChoiceAnswersPort, onSendForm = vi.fn()): CanvasChoiceRuntime => ({
  kind: "can-send",
  threadLabel: "the Work thread",
  answers: port,
  onSend: vi.fn(),
  onSendForm: onSendForm.mockResolvedValue({ status: "sent" }),
});

describe("decision form", () => {
  it("groups questions under their sections and saves each pick as it is made", async () => {
    const user = userEvent.setup();
    const { port, revise } = host();
    render(<ChoiceBlock block={form} runtime={sendable(port)} />);
    expect(await screen.findByRole("heading", { name: "Access" })).toBeInTheDocument();
    expect(screen.getByText("Who and how far")).toBeInTheDocument();
    expect(screen.getByText("0 of 4 answered")).toBeInTheDocument();

    const who = screen.getByRole("radiogroup", { name: "Who may set it?" });
    await user.click(within(who).getByRole("radio", { name: /No/ }));
    await waitFor(() => expect(screen.getByText("1 of 4 answered")).toBeInTheDocument());
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]?.[0].changes).toMatchObject([
      { kind: "set", questionId: "who", selectedOptionIds: ["no"] },
    ]);
    expect(
      within(screen.getByRole("radiogroup", { name: "Who may set it?" })).getByRole("radio", {
        name: /No/,
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("accepts every recommendation not yet answered, keeping an answer already given", async () => {
    const user = userEvent.setup();
    const { port, revise } = host();
    render(<ChoiceBlock block={form} runtime={sendable(port)} />);
    await user.click(
      within(await screen.findByRole("radiogroup", { name: "Who may set it?" })).getByRole(
        "radio",
        {
          name: /No/,
        },
      ),
    );
    await waitFor(() => expect(screen.getByText("1 of 4 answered")).toBeInTheDocument());
    await user.click(
      screen.getByRole("button", { name: "Accept every recommendation not yet answered" }),
    );
    await waitFor(() => expect(screen.getByText("2 of 4 answered")).toBeInTheDocument());
    // Only "reach" had a recommendation left to accept; "who" kept the person's own No.
    const batch = revise.mock.calls[1]?.[0].changes;
    expect(batch).toMatchObject([
      { questionId: "reach", selectedOptionIds: ["yes"], acceptedRecommendation: true },
    ]);
    expect(batch).toHaveLength(1);
    expect(await screen.findByText("Accepted the recommendation")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Accept every recommendation not yet answered" }),
    ).not.toBeInTheDocument();
  });

  it("sends the saved answers only once every question that is not optional is answered", async () => {
    const user = userEvent.setup();
    const { port } = host();
    const onSendForm = vi.fn();
    render(<ChoiceBlock block={form} runtime={sendable(port, onSendForm)} />);
    const send = await screen.findByRole("button", { name: "Send to the Work thread" });
    expect(send).toBeDisabled();
    for (const name of ["Who may set it?", "How far does it reach?", "May an agent hold it?"]) {
      await user.click(
        within(screen.getByRole("radiogroup", { name })).getByRole("radio", { name: /Yes/ }),
      );
    }
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() => expect(onSendForm).toHaveBeenCalledTimes(1));
    expect(
      onSendForm.mock.calls[0]?.[1].map((answer: { questionId: string }) => answer.questionId),
    ).toEqual(["who", "reach", "agents"]);
    expect(await screen.findByText(/Answers sent/)).toBeInTheDocument();
  });

  it("holds Send back while an edit is unsaved, then sends what the host now holds", async () => {
    const user = userEvent.setup();
    const { port } = host();
    const onSendForm = vi.fn();
    render(<ChoiceBlock block={form} runtime={sendable(port, onSendForm)} />);
    const send = await screen.findByRole("button", { name: "Send to the Work thread" });
    for (const name of ["Who may set it?", "How far does it reach?", "May an agent hold it?"]) {
      await user.click(
        within(screen.getByRole("radiogroup", { name })).getByRole("radio", { name: /Yes/ }),
      );
    }
    await waitFor(() => expect(send).toBeEnabled());
    // Typing a note is an edit the host does not hold yet: Send waits for it.
    await user.type(screen.getAllByLabelText(/^Note/)[0] as HTMLElement, "Matches a local window");
    expect(send).toBeDisabled();
    expect(screen.getByText(/Waiting for your latest answers to save/)).toBeInTheDocument();
    await waitFor(() => expect(send).toBeEnabled(), { timeout: 3_000 });
    await user.click(send);
    await waitFor(() => expect(onSendForm).toHaveBeenCalledTimes(1));
    expect(onSendForm.mock.calls[0]?.[1][0]).toMatchObject({ note: "Matches a local window" });
  });

  it("keeps what the person typed while an earlier save is still with the host", async () => {
    const user = userEvent.setup();
    const { port } = host();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      ...port,
      revise: async (command: Parameters<typeof port.revise>[0]) => {
        // The first note save waits; the pick before it does not.
        if (command.changes.some((change) => change.kind === "set" && change.note === "one")) {
          await gate;
        }
        return port.revise(command);
      },
    };
    render(<ChoiceBlock block={form} runtime={sendable(slow)} />);
    await user.click(
      within(await screen.findByRole("radiogroup", { name: "Who may set it?" })).getByRole(
        "radio",
        {
          name: /Yes/,
        },
      ),
    );
    await waitFor(() => expect(screen.getByText("1 of 4 answered")).toBeInTheDocument());
    const note = screen.getAllByLabelText(/^Note/)[0] as HTMLTextAreaElement;
    await user.type(note, "one");
    await waitFor(() => expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0), {
      timeout: 3_000,
    });
    // Typing continues while that first save is still with the host.
    await user.type(note, " two");
    release();
    await waitFor(() => expect(screen.queryByText("Saving…")).not.toBeInTheDocument());
    expect(note).toHaveValue("one two");
  });

  it("keeps the pick and shows the host's reason when an answer is not saved", async () => {
    const user = userEvent.setup();
    const { port } = host({ refuse: "The thread is archived." });
    render(<ChoiceBlock block={form} runtime={sendable(port)} />);
    await user.click(
      within(await screen.findByRole("radiogroup", { name: "Who may set it?" })).getByRole(
        "radio",
        {
          name: /No/,
        },
      ),
    );
    expect(await screen.findByText("Not saved: The thread is archived.")).toBeInTheDocument();
    expect(screen.getByText("0 of 4 answered")).toBeInTheDocument();
    expect(
      within(screen.getByRole("radiogroup", { name: "Who may set it?" })).getByRole("radio", {
        name: /No/,
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("shows saved answers without controls where the person cannot answer", async () => {
    const { port } = host();
    render(
      <ChoiceBlock
        block={form}
        runtime={{ kind: "read-only", reason: "Answer from a window on the host.", answers: port }}
      />,
    );
    expect(await screen.findByText("Answer from a window on the host.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to/ })).not.toBeInTheDocument();
    expect(screen.getByText("0 of 4 answered")).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });
});

describe("decision form message", () => {
  const answers = [
    {
      blockId: form.blockId,
      questionId: "who",
      questionFingerprint: "",
      selectedOptionIds: ["yes"],
      acceptedRecommendation: true,
      note: "Matches a local window",
      author: person,
      answeredAt: "2026-11-12T10:00:00.000Z" as never,
    },
  ];

  it("lists answers under their sections with notes and accepted recommendations", () => {
    const message = canvasDecisionFormMessage({
      canvasTitle: "Full access",
      canvasId,
      block: form,
      answers: answers.map((answer) => ({ ...answer, questionFingerprint: fingerprintOf("who") })),
    });
    expect(message).toContain(
      '(canvasId 11111111-1111-4111-8111-111111111111, choice block "decisions"): 1 of 4 answered.',
    );
    expect(message).toContain(
      "Access:\n- Who may set it?: Yes (accepted your recommendation) (note: Matches a local window)",
    );
    expect(message).toContain("- Anything else?: skipped");
  });

  it("leaves a list too long for a message to be read from the Canvas", () => {
    const long = decodeCanvasBlock({
      ...form,
      sections: undefined,
      questions: Array.from({ length: 400 }, (_, n) =>
        yesNo(`q${String(n)}`, `Decision ${"x".repeat(80)} ${String(n)}`),
      ),
    }) as CanvasChoiceBlock;
    expect(
      canvasDecisionFormMessage({ canvasTitle: "Big", canvasId, block: long, answers: [] }),
    ).toMatch(/too long to send here\. Read the answers from the Canvas/);
  });
});

function fingerprintOf(questionId: string): string {
  const question = form.questions.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error("fixture");
  return canvasChoiceQuestionFingerprint(question);
}
