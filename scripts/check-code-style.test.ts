import { describe, expect, it } from "vitest";
import {
  compareWithBaseline,
  findOxlintFindings,
  findTextFindings,
  isShippedSource,
  serializeBaseline,
} from "./check-code-style";

const FILE = "apps/server/src/feature.ts";

describe("code-style check", () => {
  it("judges shipped source and leaves tests and their scaffolding alone", () => {
    expect(isShippedSource("apps/server/src/feature.ts")).toBe(true);
    expect(isShippedSource("packages/domain/src/policy.ts")).toBe(true);
    expect(isShippedSource("apps/mobile/design-system/theme.tsx")).toBe(true);
    expect(isShippedSource("apps/server/src/feature.test.ts")).toBe(false);
    expect(isShippedSource("apps/server/src/feature.test.mts")).toBe(false);
    expect(isShippedSource("packages/cli/src/launcher.spec.cts")).toBe(false);
    expect(isShippedSource("packages/cli/src/types.d.mts")).toBe(false);
    expect(isShippedSource("apps/web/src/App.test-fixtures.ts")).toBe(false);
    expect(isShippedSource("apps/server/src/providers/fixtures/fakeClaudeCli.ts")).toBe(false);
    expect(isShippedSource("apps/server/src/preview/previewTestFixtures.ts")).toBe(false);
    expect(isShippedSource("apps/server/src/browser/browserRuntime.smoke.ts")).toBe(false);
    expect(isShippedSource("apps/docs/.vitepress/env.d.ts")).toBe(false);
    expect(isShippedSource("scripts/check-code-style.ts")).toBe(false);
    expect(isShippedSource("apps/web/src/styles/octant.css")).toBe(false);
  });

  it("finds a cast laundered through unknown and a tracker id, with their lines", () => {
    expect(
      findTextFindings({
        [FILE]: [
          "const a = value as unknown as Thread;",
          "// Keeps the purge honest (OCT-366).",
          "const label = `BOOT-02`;",
          "const example = 'ENG-12';",
          "const encoding = 'UTF-8';",
        ].join("\n"),
      }),
    ).toEqual([
      { rule: "as-unknown-as", file: FILE, line: 1 },
      { rule: "tracker-id", file: FILE, line: 2 },
      { rule: "tracker-id", file: FILE, line: 3 },
    ]);
  });

  it("keeps only the oxlint findings this check owns", () => {
    expect(
      findOxlintFindings({
        diagnostics: [
          {
            code: "typescript(no-explicit-any)",
            filename: FILE,
            labels: [{ span: { line: 4 } }],
          },
          {
            code: "typescript(no-non-null-assertion)",
            filename: FILE,
            labels: [{ span: { line: 9 } }],
          },
          { code: "eslint(no-debugger)", filename: FILE, labels: [{ span: { line: 2 } }] },
        ],
      }),
    ).toEqual([
      { rule: "explicit-any", file: FILE, line: 4 },
      { rule: "non-null-assertion", file: FILE, line: 9 },
    ]);
  });

  it("refuses a new finding in a file the baseline already records", () => {
    const findings = [
      { rule: "explicit-any", file: FILE, line: 1 },
      { rule: "explicit-any", file: FILE, line: 2 },
    ] as const;
    expect(compareWithBaseline(findings, { "explicit-any": { [FILE]: 1 } })).toEqual([
      { kind: "exceeded", rule: "explicit-any", file: FILE, recorded: 1, current: 2 },
    ]);
  });

  it("refuses a finding in a file the baseline does not know", () => {
    expect(compareWithBaseline([{ rule: "non-null-assertion", file: FILE, line: 3 }], {})).toEqual([
      { kind: "exceeded", rule: "non-null-assertion", file: FILE, recorded: 0, current: 1 },
    ]);
  });

  it("asks for the baseline to shrink once a finding is fixed", () => {
    expect(compareWithBaseline([], { "as-unknown-as": { [FILE]: 2 } })).toEqual([
      { kind: "stale", rule: "as-unknown-as", file: FILE, recorded: 2, current: 0 },
    ]);
  });

  it("never baselines a tracker id", () => {
    const findings = [{ rule: "tracker-id", file: FILE, line: 1 }] as const;
    expect(serializeBaseline(findings)).toBe("{}\n");
    expect(compareWithBaseline(findings, { "tracker-id": { [FILE]: 1 } })).toEqual([
      { kind: "exceeded", rule: "tracker-id", file: FILE, recorded: 0, current: 1 },
    ]);
  });

  it("passes when the tree matches the recorded counts", () => {
    const findings = [{ rule: "as-unknown-as", file: FILE, line: 1 }] as const;
    const baseline = JSON.parse(serializeBaseline(findings)) as Record<string, unknown>;
    expect(baseline).toEqual({ "as-unknown-as": { [FILE]: 1 } });
    expect(compareWithBaseline(findings, { "as-unknown-as": { [FILE]: 1 } })).toEqual([]);
  });
});
