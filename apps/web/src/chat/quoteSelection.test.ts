import { describe, expect, it } from "vitest";
import {
  formatOutgoingMessageWithQuotes,
  quoteChipLabel,
  type TranscriptQuoteChip,
} from "./quoteSelection";

const quote = (overrides: Partial<TranscriptQuoteChip> = {}): TranscriptQuoteChip => ({
  id: "q1",
  turnId: "00000000-0000-4000-8000-000000000802",
  text: "Keep the fold quiet.",
  ...overrides,
});

describe("quoteChipLabel", () => {
  it("returns the trimmed excerpt when it fits", () => {
    expect(quoteChipLabel("  Keep the fold quiet.  ")).toBe("Keep the fold quiet.");
  });

  it("clips a long excerpt for the chip", () => {
    const long = "word ".repeat(40).trim();
    const label = quoteChipLabel(long);
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(48);
  });
});

describe("formatOutgoingMessageWithQuotes", () => {
  it("returns the draft alone when there are no quotes", () => {
    expect(formatOutgoingMessageWithQuotes({ draft: " Please fix. ", quotes: [] })).toBe(
      "Please fix.",
    );
  });

  it("attributes each quote to its turn and keeps the draft after", () => {
    const markdown = formatOutgoingMessageWithQuotes({
      draft: "Apply that.",
      quotes: [quote()],
    });
    expect(markdown).toContain("turn 00000000-0000-4000-8000-000000000802");
    expect(markdown).toContain("Keep the fold quiet.");
    expect(markdown).toContain("Quoted for reference only");
    expect(markdown.endsWith("Apply that.")).toBe(true);
  });

  it("sends quote attribution alone when the draft is empty", () => {
    const markdown = formatOutgoingMessageWithQuotes({
      draft: "   ",
      quotes: [quote({ text: "Only the excerpt." })],
    });
    expect(markdown).toContain("Only the excerpt.");
    expect(markdown).not.toMatch(/\n\n$/);
  });
});
