import { describe, expect, it } from "vitest";
import { checkDecisionsRegister } from "./check-decisions-register";

const REGISTER = `# Decisions and requirements

- **Status** is one of Built, Partly built, or Designed, not built.

## Summary

| Area                                    | Decisions | Built | Partly built | Designed, not built |
| --------------------------------------- | --------- | ----- | ------------ | ------------------- |
| [Modes, Projects and authority](#modes-projects-and-authority) | 2 | 1 | 1 | 0 |
| [Bots](#bots)                           | 1         | 0     | 0            | 1                   |
| **All areas**                           | **3**     | **1** | **1**        | **1**               |

## Modes, Projects and authority

### Thread kind is permanent

A thread never changes kind.

Status: Built. Since: 2026-10-31. Detail: [Architecture](../architecture.md).

### Done is server-enforced

Status: Partly built. Detail: [Architecture](../architecture.md).

## Bots

### Bots have desktops

Status: Designed, not built. Detail: [Bots](bots.md).
`;

function reasons(text: string): ReadonlyArray<string> {
  const check = checkDecisionsRegister(text);
  return check.status === "consistent" ? [] : check.problems.map((problem) => problem.reason);
}

describe("checkDecisionsRegister", () => {
  it("accepts a register whose summary matches its entries", () => {
    expect(checkDecisionsRegister(REGISTER)).toEqual({ status: "consistent", entries: 3 });
  });

  it("refuses a summary row whose built count differs from the entries under its heading", () => {
    const drifted = REGISTER.replace("| 2 | 1 | 1 | 0 |", "| 2 | 2 | 1 | 0 |");
    expect(reasons(drifted)).toEqual([
      'the summary row for "Modes, Projects and authority" claims 2 under "Built"; the entries count 1',
    ]);
  });

  it("refuses a total row that is not the sum of the areas, and names its line", () => {
    const check = checkDecisionsRegister(REGISTER.replace("**3**", "**2**"));
    expect(check).toEqual({
      status: "inconsistent",
      problems: [
        {
          line: 11,
          reason:
            'the summary row for all areas claims **2** under "Decisions"; the entries count 3',
        },
      ],
    });
  });

  it("refuses a status outside the three the register defines", () => {
    const reworded = REGISTER.replace("Status: Partly built.", "Status: Partially built.");
    expect(reasons(reworded)).toContain(
      'the status of "Done is server-enforced" begins with none of Built. | Partly built. | Designed, not built.',
    );
  });

  it("refuses an entry with no status line and one with two", () => {
    const missing = REGISTER.replace("Status: Designed, not built. Detail: [Bots](bots.md).\n", "");
    expect(reasons(missing)).toContain(
      '"Bots have desktops" has 0 lines starting "Status: "; an entry has exactly one',
    );
    const doubled = REGISTER.replace("A thread never changes kind.", "Status: Built.");
    expect(reasons(doubled)).toContain(
      '"Thread kind is permanent" has 2 lines starting "Status: "; an entry has exactly one',
    );
  });

  it("refuses an area that has no summary row", () => {
    const unlisted = `${REGISTER}\n## Workspace\n\n### Files open in tabs\n\nStatus: Built.\n`;
    expect(reasons(unlisted)).toContain('the summary has no row for the area "Workspace"');
  });

  it("refuses a summary row whose link matches no area heading", () => {
    const renamed = REGISTER.replace("## Bots", "## Bots and routines");
    expect(reasons(renamed)).toEqual([
      'the summary has no row for the area "Bots and routines"',
      "the summary links to #bots, which no area heading has",
    ]);
  });
});
