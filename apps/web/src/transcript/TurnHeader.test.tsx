import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TurnHeader, turnTimeTitle } from "./TurnHeader";

describe("TurnHeader", () => {
  it("keeps successful reply status without a Completed word and leaves the actions to the reply's end", () => {
    render(
      <TurnHeader at="2026-01-02T03:04:05.000Z" outcome="completed" workedFor="Worked for 4s" />,
    );
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.getByText("Worked for 4s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fork from here" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
  });

  it.each(["failed", "interrupted", "waiting", "cancelled"] as const)(
    "keeps the %s outcome visible",
    (outcome) => {
      render(<TurnHeader outcome={outcome} />);
      expect(
        screen.getByText(
          outcome === "waiting"
            ? "Waiting for approval"
            : outcome[0]?.toUpperCase() + outcome.slice(1),
        ),
      ).toBeVisible();
    },
  );

  it("keeps provider details out of the transcript row while exposing them with the timestamp on hover", () => {
    const provider = "Pi RPC — GPT-5.3 Codex Spark";
    const at = "2026-01-02T03:04:05.000Z";

    render(<TurnHeader at={at} outcome="completed" provider={provider} />);

    expect(screen.queryByText(provider)).not.toBeInTheDocument();
    expect(screen.getByTitle(`${provider} · ${turnTimeTitle(at)}`)).toBeInTheDocument();
  });
});
