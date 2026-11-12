import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TokenExportError,
  TokenResolver,
  blockDeclarations,
  cascade,
  checkThemeAgreement,
  dtcgValue,
  evaluateCalc,
  generate,
  mixColors,
  renderCss,
  selectExports,
  staleOutputs,
  topLevelBlocks,
  type CascadeBlock,
  type Declaration,
} from "./export-design-tokens";

const FILE = "fixture.css";

function declare(css: string, selector = ":root"): ReadonlyArray<Declaration> {
  const block = topLevelBlocks(css).find((candidate) => candidate.selector === selector);
  if (block === undefined) throw new Error(`no ${selector}`);
  return blockDeclarations(block, FILE);
}

function model(css: string, light = "") {
  const blocks: CascadeBlock[] = [{ declarations: declare(css), applies: "both" }];
  if (light !== "") {
    blocks.push({
      declarations: declare(light, 'html[data-octant-theme-mode="light"]'),
      applies: "light",
    });
  }
  return cascade(blocks);
}

describe("reading the stylesheets", () => {
  it("ignores declarations inside media queries and comments", () => {
    const css = `/* --x: 9px; */ :root { --a: 1px; } @media (min-width: 1px) { :root { --b: 2px; } }`;
    expect(declare(css).map((declaration) => declaration.name)).toEqual(["--a"]);
  });

  it("splits light-dark() into a dark and a light value", () => {
    const tokens = model(":root { --c: light-dark(#fff, #000); }");
    expect(tokens.get("--c")).toMatchObject({ light: "#fff", dark: "#000" });
  });

  it("lets a light block override only the light value", () => {
    const tokens = model(
      ":root { --c: #000; }",
      'html[data-octant-theme-mode="light"] { --c: #fff; }',
    );
    expect(tokens.get("--c")).toMatchObject({ dark: "#000", light: "#fff" });
  });

  it("keeps a light override when a later :root block redeclares the token", () => {
    const light = 'html[data-octant-theme-mode="light"]';
    const tokens = cascade([
      { declarations: declare(":root { --c: #000; }"), applies: "both" },
      { declarations: declare(`${light} { --c: #fff; }`, light), applies: "light" },
      { declarations: declare(":root { --c: #111; }"), applies: "both" },
    ]);
    expect(tokens.get("--c")).toMatchObject({ dark: "#111", light: "#fff" });
  });

  it("refuses a name declared twice in one block", () => {
    expect(() => declare(":root { --a: 1px; --a: 2px; }")).toThrow(/declared twice/);
  });

  it("refuses a light-dark() without both values", () => {
    expect(() => model(":root { --c: light-dark(#fff); }")).toThrow(/light and a dark value/);
  });

  it("refuses a light override that has no base value", () => {
    expect(() =>
      cascade([
        {
          declarations: declare(
            'html[data-octant-theme-mode="light"] { --c: #fff; }',
            'html[data-octant-theme-mode="light"]',
          ),
          applies: "light",
        },
      ]),
    ).toThrow(/no base value/);
  });
});

describe("resolving references", () => {
  it("replaces var() and folds what a browser would compute", () => {
    const tokens = model(
      ":root { --step: calc(var(--size, 13px) / 13); --size: 13px; --xs: calc(12 * var(--step)); --m: color-mix(in srgb, #fff 50%, #000); }",
    );
    const resolver = new TokenResolver(tokens);
    expect(resolver.resolve("--xs", "dark")).toBe("12px");
    expect(resolver.resolve("--m", "dark")).toBe("#808080");
  });

  it("uses the fallback when the named token does not exist", () => {
    const resolver = new TokenResolver(model(":root { --a: var(--missing, 7px); }"));
    expect(resolver.resolve("--a", "dark")).toBe("7px");
  });

  it("refuses an unresolved reference", () => {
    const resolver = new TokenResolver(model(":root { --a: var(--missing); }"));
    expect(() => resolver.resolve("--a", "dark")).toThrow(TokenExportError);
    expect(() => resolver.resolve("--a", "dark")).toThrow(/unresolved reference --missing/);
  });

  it("refuses a circular reference", () => {
    const resolver = new TokenResolver(model(":root { --a: var(--b); --b: var(--a); }"));
    expect(() => resolver.resolve("--a", "dark")).toThrow(/circular/);
  });

  it("keeps an expression it cannot compute without a browser", () => {
    const resolver = new TokenResolver(
      model(":root { --h: clamp(56px, 11vw, 132px); --w: calc(100% - 4px); }"),
    );
    expect(resolver.resolve("--h", "dark")).toBe("clamp(56px, 11vw, 132px)");
    expect(resolver.resolve("--w", "dark")).toBe("calc(100% - 4px)");
  });
});

describe("colour and length arithmetic", () => {
  it("mixes in srgb and oklab like a browser", () => {
    expect(mixColors("color-mix(in srgb, white 50%, black)")).toBe("#808080");
    expect(mixColors("color-mix(in oklab, white, black)")).toBe("#636363");
    expect(mixColors("color-mix(in oklab, #f5f5f7 7%, transparent)")).toBe(
      "rgba(245, 245, 247, 0.07)",
    );
  });

  it("evaluates calc over lengths and refuses mixed units", () => {
    expect(evaluateCalc("calc(12 * 1px)")).toBe("12px");
    expect(evaluateCalc("calc(var(--x) * 2)")).toBeUndefined();
    expect(evaluateCalc("calc(4px - 1px)")).toBe("3px");
    expect(evaluateCalc("calc(100% - 4px)")).toBeUndefined();
  });
});

describe("choosing what to export", () => {
  it("pulls in a token an exported value reads and keeps the reference", () => {
    const tokens = model(
      ":root { --oct-bg: var(--internal-ground); --internal-ground: #101010; --oct-shell-thing: 1px; }",
    );
    const exported = selectExports(tokens);
    expect(exported.map((token) => [token.name, token.support])).toEqual([
      ["--oct-bg", false],
      ["--internal-ground", true],
    ]);
    const css = renderCss(exported, ["fixture.css"]);
    expect(css).toContain("--oct-bg: var(--internal-ground);");
    expect(css).not.toContain("--oct-shell-thing");
  });

  it("gives a light value only where it differs from dark", () => {
    const tokens = model(":root { --oct-bg: light-dark(#fff, #000); --oct-fg: #111; }");
    const css = renderCss(selectExports(tokens), ["fixture.css"]);
    const light = css.split(':root[data-theme="light"]')[1] ?? "";
    expect(light).toContain("--oct-bg: #fff;");
    expect(light).not.toContain("--oct-fg");
  });

  it("writes a translucent colour as sRGB components, an alpha and an opaque hex", () => {
    expect(dtcgValue("rgba(245, 245, 247, 0.14)")).toEqual({
      type: "color",
      value: {
        colorSpace: "srgb",
        components: [0.9608, 0.9608, 0.9686],
        alpha: 0.14,
        hex: "#f5f5f7",
      },
    });
    expect(dtcgValue("#ffffff")?.value).toEqual({
      colorSpace: "srgb",
      components: [1, 1, 1],
      hex: "#ffffff",
    });
  });

  it("writes lengths in px and rem and durations as objects with a unit", () => {
    expect(dtcgValue("12px")).toEqual({ type: "dimension", value: { value: 12, unit: "px" } });
    expect(dtcgValue("0.75rem")).toEqual({
      type: "dimension",
      value: { value: 0.75, unit: "rem" },
    });
    expect(dtcgValue("150ms")).toEqual({ type: "duration", value: { value: 150, unit: "ms" } });
    expect(dtcgValue("1.6s")).toEqual({ type: "duration", value: { value: 1.6, unit: "s" } });
    expect(dtcgValue("ease")).toEqual({ type: "cubicBezier", value: [0.25, 0.1, 0.25, 1] });
  });

  it("writes a layered shadow as shadow objects and leaves a value the format cannot express out", () => {
    const shadow = dtcgValue("inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 2px #000000");
    expect(shadow?.type).toBe("shadow");
    expect(Array.isArray(shadow?.value) ? shadow.value.length : 0).toBe(2);
    expect(dtcgValue("-0.025em")).toBeUndefined();
    expect(dtcgValue("clamp(56px, 11vw, 132px)")).toBeUndefined();
    expect(dtcgValue("150%")).toBeUndefined();
    expect(dtcgValue("none")).toBeUndefined();
  });
});

describe("the committed tokens.json", () => {
  const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
  const unit = (value: unknown, units: ReadonlyArray<string>): boolean =>
    isRecord(value) && isNumber(value["value"]) && units.includes(String(value["unit"]));
  const colour = (value: unknown): boolean =>
    isRecord(value) &&
    value["colorSpace"] === "srgb" &&
    Array.isArray(value["components"]) &&
    value["components"].length === 3 &&
    value["components"].every((part) => isNumber(part) && Number(part) >= 0 && Number(part) <= 1) &&
    (value["alpha"] === undefined || (isNumber(value["alpha"]) && Number(value["alpha"]) < 1)) &&
    /^#[0-9a-f]{6}$/.test(String(value["hex"]));
  const shadow = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.length > 0 && value.every(shadow)
      : isRecord(value) &&
        colour(value["color"]) &&
        ["offsetX", "offsetY", "blur", "spread"].every((key) => unit(value[key], ["px", "rem"]));
  const FORMS: Readonly<Record<string, (value: unknown) => boolean>> = {
    color: colour,
    dimension: (value) => unit(value, ["px", "rem"]),
    duration: (value) => unit(value, ["ms", "s"]),
    number: isNumber,
    fontWeight: (value) => isNumber(value) && Number(value) >= 1 && Number(value) <= 1000,
    fontFamily: (value) =>
      Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string"),
    cubicBezier: (value) =>
      Array.isArray(value) &&
      value.length === 4 &&
      value.every(isNumber) &&
      Number(value[0]) >= 0 &&
      Number(value[0]) <= 1 &&
      Number(value[2]) >= 0 &&
      Number(value[2]) <= 1,
    shadow,
  };

  it("holds every typed token, and its light value, in the form its type requires", () => {
    const json = JSON.parse(
      readFileSync(new URL("../packages/theme/tokens/tokens.json", import.meta.url), "utf8"),
    ) as unknown;
    const problems: string[] = [];
    let typed = 0;
    for (const [groupName, group] of Object.entries(isRecord(json) ? json : {})) {
      if (groupName.startsWith("$") || !isRecord(group)) continue;
      for (const [name, token] of Object.entries(group)) {
        if (name.startsWith("$") || !isRecord(token)) continue;
        typed += 1;
        const form = FORMS[String(token["$type"])];
        const extension = isRecord(token["$extensions"])
          ? token["$extensions"]["com.octant"]
          : undefined;
        const light = isRecord(extension) ? extension["light"] : undefined;
        if (form === undefined) problems.push(`${name}: unknown type ${String(token["$type"])}`);
        else if (!form(token["$value"]))
          problems.push(`${name}: $value is not a ${String(token["$type"])}`);
        else if (light !== undefined && !form(light))
          problems.push(`${name}: light is not a ${String(token["$type"])}`);
      }
    }
    expect(typed).toBeGreaterThan(200);
    expect(problems).toEqual([]);
  });
});

describe("agreement with the theme package", () => {
  const tokens = model(
    ":root { --octant-workspace: #1a1a1a; }",
    'html[data-octant-theme-mode="light"] { --octant-workspace: #ffffff; }',
  );

  it("accepts a stylesheet that mirrors the theme defaults", () => {
    expect(
      checkThemeAgreement(tokens, ["workspace"], {
        dark: { workspace: "#1A1A1A" },
        light: { workspace: "#ffffff" },
      }),
    ).toEqual([]);
  });

  it("refuses a role whose two copies have drifted, or that has no light default", () => {
    const problems = checkThemeAgreement(tokens, ["workspace", "chrome"], {
      dark: { workspace: "#222222", chrome: "#000000" },
      light: { workspace: "#ffffff" },
    });
    expect(problems).toEqual([
      "--octant-workspace is #1a1a1a in the dark stylesheet but the theme package says #222222",
      "theme role chrome has no light default",
    ]);
  });
});

describe("the committed export", () => {
  it("is current, resolves every reference, and carries both modes", () => {
    const generated = generate();
    expect(staleOutputs(generated)).toEqual([]);
    const css = generated.files["tokens.css"];
    expect(css).toContain("--oct-radius-md:");
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain("@media (prefers-color-scheme: light)");
    const json = JSON.parse(generated.files["tokens.json"]) as Record<string, unknown>;
    expect(Object.keys(json)).toContain("radius");
  });
});

describe("the minimum recipes", () => {
  const read = (name: string): string =>
    readFileSync(new URL(`../packages/theme/tokens/${name}`, import.meta.url), "utf8");
  const recipes = read("recipes.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("hold no colour of their own", () => {
    expect(recipes).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklab|oklch)\(/);
  });

  it("read only tokens the export defines", () => {
    const defined = new Set(
      [...read("tokens.css").matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]),
    );
    const used = [...recipes.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });
});
