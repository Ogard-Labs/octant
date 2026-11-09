import type { ReactNode } from "react";
import { QuestionnaireDraftsProvider } from "./questionnaireDrafts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuestionnaireCard, QuestionnaireSummary } from "./QuestionnaireCard";
const draftIdentity = { scope: "chat:thread", requestId: "request" };
const wrap = (content: ReactNode, windowId = "window") => (
  <QuestionnaireDraftsProvider serverUrl="local" windowId={windowId}>
    {content}
  </QuestionnaireDraftsProvider>
);
const questionnaire = {
  questions: [
    {
      id: "formats",
      prompt: "Which formats?",
      selection: "multiple" as const,
      maxSelections: 2,
      options: [
        { id: "pdf", label: "PDF", recommended: true },
        { id: "md", label: "Markdown" },
        { id: "html", label: "HTML" },
      ],
    },
    {
      id: "open",
      prompt: "After exporting?",
      selection: "single" as const,
      options: [
        { id: "save", label: "Save only" },
        { id: "open", label: "Open the file" },
      ],
    },
  ],
};

describe("inline questionnaires", () => {
  it("omits the global comment input when the form cannot receive a comment", async () => {
    const submit = vi.fn(async () => true);
    render(
      <QuestionnaireCard
        prompt="Provider form"
        questionnaire={{ ...questionnaire, allowComment: false }}
        onAnswer={submit}
      />,
    );
    expect(screen.queryByRole("textbox", { name: /Anything to add/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Markdown" }));
    await userEvent.setup().click(screen.getByRole("radio", { name: "Save only" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Send answers" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        version: 1,
        answers: [
          { questionId: "formats", selectedOptionIds: ["md"] },
          { questionId: "open", selectedOptionIds: ["save"] },
        ],
      }),
    );
  });
  it("keeps choices unselected, submits one complete set with a comment, and shows the submitted summary", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => true);
    render(
      wrap(
        <QuestionnaireCard
          draftIdentity={draftIdentity}
          prompt="Before I implement"
          questionnaire={questionnaire}
          onAnswer={submit}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "PDF (Recommended)" }));
    await user.click(screen.getByRole("checkbox", { name: "Markdown" }));
    expect(screen.getByRole("checkbox", { name: "HTML" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Save only" }));
    await user.type(screen.getByRole("textbox", { name: /Anything to add/ }), "After the build");
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send answers" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        version: 1,
        answers: [
          { questionId: "formats", selectedOptionIds: ["pdf", "md"] },
          { questionId: "open", selectedOptionIds: ["save"] },
        ],
        comment: "After the build",
      }),
    );
    await user.click(screen.getByText("Answers sent · Before I implement"));
    expect(screen.getByText("PDF, Markdown")).toBeVisible();
    expect(screen.getByText("After the build")).toBeVisible();
  });
  it("keeps unsent choices, written answers and comments when the same request is reopened", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => true);
    const card = (
      <QuestionnaireCard
        draftIdentity={draftIdentity}
        prompt="Choices"
        questionnaire={questionnaire}
        onAnswer={submit}
      />
    );
    const { rerender } = render(wrap(card));
    await user.click(screen.getByRole("checkbox", { name: "PDF (Recommended)" }));
    const group = screen.getByRole("group", { name: "After exporting?" });
    await user.click(within(group).getByRole("radio", { name: "Write another answer" }));
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "Ask after saving");
    await user.type(screen.getByRole("textbox", { name: /Anything to add/ }), "Keep originals");
    rerender(wrap(<p>Inbox</p>));
    rerender(wrap(card));
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("Ask after saving");
    expect(screen.getByRole("textbox", { name: /Anything to add/ })).toHaveValue("Keep originals");
    expect(submit).not.toHaveBeenCalled();
  });
  it("keeps each window's answers private without letting another window erase the source draft", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    const card = (
      <QuestionnaireCard
        draftIdentity={draftIdentity}
        prompt="Choices"
        questionnaire={questionnaire}
        onAnswer={submit}
      />
    );
    const source = render(wrap(card, "source"));
    await user.click(within(source.container).getByRole("checkbox", { name: "PDF (Recommended)" }));
    await user.type(
      within(source.container).getByRole("textbox", { name: /Anything to add/ }),
      "Source note",
    );
    source.rerender(wrap(<p>Inbox</p>, "source"));
    const other = render(wrap(card, "other"));
    expect(
      within(other.container).getByRole("checkbox", { name: "PDF (Recommended)" }),
    ).not.toBeChecked();
    expect(within(other.container).getByRole("textbox", { name: /Anything to add/ })).toHaveValue(
      "",
    );
    await user.click(within(other.container).getByRole("checkbox", { name: "Markdown" }));
    other.unmount();
    source.rerender(wrap(card, "source"));
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Markdown" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: /Anything to add/ })).toHaveValue("Source note");
    expect(submit).not.toHaveBeenCalled();
  });
  it("discards answers when the request or questionnaire definition changes", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    const card = (
      <QuestionnaireCard
        draftIdentity={draftIdentity}
        prompt="Choices"
        questionnaire={questionnaire}
        onAnswer={submit}
      />
    );
    const { rerender } = render(wrap(card));
    await user.click(screen.getByRole("checkbox", { name: "PDF (Recommended)" }));
    await user.type(screen.getByRole("textbox", { name: /Anything to add/ }), "Old note");
    rerender(
      wrap(
        <QuestionnaireCard
          draftIdentity={draftIdentity}
          prompt="Changed choices"
          questionnaire={questionnaire}
          onAnswer={submit}
        />,
      ),
    );
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: /Anything to add/ })).toHaveValue("");
    rerender(wrap(card));
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "PDF (Recommended)" }));
    rerender(
      wrap(
        <QuestionnaireCard
          draftIdentity={{ ...draftIdentity, requestId: "replacement" }}
          prompt="Choices"
          questionnaire={questionnaire}
          onAnswer={submit}
        />,
      ),
    );
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).not.toBeChecked();
    expect(submit).not.toHaveBeenCalled();
  });
  it("clears an accepted draft while keeping its submitted summary readable", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => true);
    const card = (
      <QuestionnaireCard
        draftIdentity={draftIdentity}
        prompt="Choices"
        questionnaire={questionnaire}
        onAnswer={submit}
      />
    );
    const { rerender } = render(wrap(card));
    await user.click(screen.getByRole("checkbox", { name: "PDF (Recommended)" }));
    await user.click(screen.getByRole("radio", { name: "Save only" }));
    await user.type(screen.getByRole("textbox", { name: /Anything to add/ }), "Submitted note");
    await user.click(screen.getByRole("button", { name: "Send answers" }));
    await user.click(await screen.findByText("Answers sent · Choices"));
    expect(screen.getByText("Submitted note")).toBeVisible();
    rerender(wrap(<p>Inbox</p>));
    rerender(wrap(card));
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: /Anything to add/ })).toHaveValue("");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("keeps the draft after a refused answer and supports a written alternative", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => false);
    render(<QuestionnaireCard prompt="Choices" questionnaire={questionnaire} onAnswer={submit} />);
    await user.click(screen.getByRole("checkbox", { name: "PDF (Recommended)" }));
    const group = screen.getByRole("group", { name: "After exporting?" });
    await user.click(within(group).getByRole("radio", { name: "Write another answer" }));
    await user.type(
      within(group).getByRole("textbox", { name: "Your answer" }),
      "Ask after saving",
    );
    await user.click(screen.getByRole("button", { name: "Send answers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not accepted");
    expect(screen.getByRole("checkbox", { name: "PDF (Recommended)" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("Ask after saving");
  });
  it("disables submission while the answer is in flight", async () => {
    const user = userEvent.setup();
    let finish: (value: boolean) => void = () => undefined;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <QuestionnaireCard
        prompt="Choice"
        questionnaire={{
          questions: questionnaire.questions.filter((question) => question.id === "open"),
        }}
        onAnswer={submit}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Save only" }));
    await user.dblClick(screen.getByRole("button", { name: "Send answers" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending answers…" })).toBeDisabled();
    finish(true);
    expect(await screen.findByText("Answers sent · Choice")).toBeVisible();
  });
  it("reconstructs readable labels and comments from the saved response", async () => {
    const user = userEvent.setup();
    render(
      <QuestionnaireSummary
        prompt="Saved questionnaire"
        questionnaire={questionnaire}
        answer={JSON.stringify({
          version: 1,
          answers: [
            { questionId: "formats", selectedOptionIds: ["md"] },
            { questionId: "open", selectedOptionIds: [], customAnswer: "Ask first" },
          ],
          comment: "Keep originals",
        })}
      />,
    );
    await user.click(screen.getByText("Answers sent · Saved questionnaire"));
    expect(screen.getByText("Markdown")).toBeVisible();
    expect(screen.getByText("Ask first")).toBeVisible();
    expect(screen.getByText("Keep originals")).toBeVisible();
  });
});
