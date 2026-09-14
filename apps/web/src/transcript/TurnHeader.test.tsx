import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TurnHeader, turnTimeTitle } from "./TurnHeader";

describe("TurnHeader", () => {
  it("keeps provider details out of the transcript row while exposing them with the timestamp on hover", () => {
    const provider = "Pi RPC — GPT-5.3 Codex Spark";
    const at = "2026-01-02T03:04:05.000Z";

    render(<TurnHeader at={at} outcome="completed" provider={provider} />);

    expect(screen.queryByText(provider)).not.toBeInTheDocument();
    expect(screen.getByTitle(`${provider} · ${turnTimeTitle(at)}`)).toBeInTheDocument();
  });
});
