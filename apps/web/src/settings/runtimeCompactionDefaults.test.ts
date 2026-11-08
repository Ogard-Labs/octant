import { describe, expect, it } from "vitest";
import { runtimeCompactionDefaultsText } from "./runtimeCompactionDefaults";

describe("saying what each runtime does on its own", () => {
  it("names each runtime's own point from the person's files", () => {
    expect(
      runtimeCompactionDefaultsText({
        claude: { autoCompact: true, autoCompactWindow: 180_000 },
        codex: { autoCompactTokenLimit: 150_000 },
      }),
    ).toBe(
      "Your own settings: Claude Code compacts by itself at 167K; Codex at 150K. Octant leaves those files as they are.",
    );
  });

  it("names the defaults, and an auto-compact switched off", () => {
    expect(runtimeCompactionDefaultsText({ claude: { autoCompact: false }, codex: {} })).toBe(
      "Your own settings: Claude Code has auto-compact off; Codex at its model's own limit. Octant leaves those files as they are.",
    );
  });
});
