import { decodeCanvasBlock, type CanvasChoiceBlock } from "@octant/contracts/canvas";
import type { QuestionnaireResponse } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { canvasChoiceMessage } from "../canvasChoiceMessage";
import { CANVAS_CHOICE_DEFAULT_READ_ONLY_REASON, ChoiceBlock } from "./ChoiceBlock";

const choice = decodeCanvasBlock({
  blockId: "pick-rollout",
  schemaVersion: 27,
  kind: "choice",
  prompt: "Which rollout should we take?",
  questions: [
    {
      id: "rollout",
      prompt: "Rollout",
      selection: "single",
      options: [
        { id: "staged", label: "Staged", description: "Ten percent a day" },
        { id: "all", label: "All at once" },
      ],
    },
  ],
}) as CanvasChoiceBlock;

describe("ChoiceBlock", () => {
  it("sends the answers to a long decision list whole, past the inline questionnaire's four", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async (_block: CanvasChoiceBlock, _response: QuestionnaireResponse) => ({
      status: "sent" as const,
    }));
    const [first] = choice.questions;
    const long = decodeCanvasBlock({
      ...choice,
      questions: Array.from({ length: 24 }, (_, n) => ({
        ...first,
        id: `q${String(n)}`,
        prompt: `Decision ${String(n + 1)}`,
      })),
    }) as CanvasChoiceBlock;
    render(
      <ChoiceBlock
        block={long}
        runtime={{ kind: "can-send", threadLabel: "the Work thread", onSend }}
      />,
    );
    for (const radio of screen.getAllByRole("radio", { name: /Staged/ })) await user.click(radio);
    await user.click(screen.getByRole("button", { name: "Send to the Work thread" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[1].answers).toHaveLength(24);
  });

  it("keeps a choice as a draft until the person sends it, then sends it once", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => ({ status: "sent" as const }));
    render(
      <ChoiceBlock
        block={choice}
        runtime={{ kind: "can-send", threadLabel: "the Work thread", onSend }}
      />,
    );
    const send = screen.getByRole("button", { name: "Send to the Work thread" });
    expect(send).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Staged/ }));
    expect(screen.getByRole("radio", { name: /Staged/ })).toHaveAttribute("aria-checked", "true");
    expect(onSend).not.toHaveBeenCalled();

    await user.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith(choice, {
      version: 1,
      answers: [{ questionId: "rollout", selectedOptionIds: ["staged"] }],
    });
    expect(await screen.findByText(/Answers sent/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to/ })).not.toBeInTheDocument();
  });

  it("keeps the draft and shows the host's reason when the thread refuses the message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => ({
      status: "refused" as const,
      message: "The host refused the message: thread unavailable.",
    }));
    render(
      <ChoiceBlock
        block={choice}
        runtime={{ kind: "can-send", threadLabel: "the Work thread", onSend }}
      />,
    );
    await user.click(screen.getByRole("radio", { name: /All at once/ }));
    await user.click(screen.getByRole("button", { name: "Send to the Work thread" }));
    expect(
      await screen.findByText("The host refused the message: thread unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /All at once/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("reads only, with its reason, where no thread can take the answer", () => {
    const { rerender } = render(<ChoiceBlock block={choice} />);
    expect(screen.getByText("Staged")).toBeInTheDocument();
    expect(screen.getByText(CANVAS_CHOICE_DEFAULT_READ_ONLY_REASON)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();

    rerender(
      <ChoiceBlock
        block={choice}
        runtime={{ kind: "read-only", reason: "This is a shared copy." }}
      />,
    );
    expect(screen.getByText("This is a shared copy.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("canvasChoiceMessage", () => {
  it("names the Canvas and block and lists the chosen labels and a written answer", () => {
    const twoQuestions = {
      ...choice,
      questions: [
        ...choice.questions,
        {
          id: "note",
          prompt: "Anything else",
          selection: "single" as const,
          options: [{ id: "none", label: "No" }],
        },
      ],
    };
    expect(
      canvasChoiceMessage({
        canvasTitle: "Rollout plan",
        canvasId: "canvas-1",
        block: twoQuestions,
        response: {
          version: 1,
          answers: [
            { questionId: "rollout", selectedOptionIds: ["staged"] },
            { questionId: "note", selectedOptionIds: [], customAnswer: "Start with staff." },
          ],
        },
      }),
    ).toBe(
      [
        'My answer to "Which rollout should we take?" in the Canvas "Rollout plan" (canvasId canvas-1, choice block "pick-rollout"):',
        "- Rollout: Staged",
        "- Anything else: written answer: Start with staff.",
      ].join("\n"),
    );
  });
});
