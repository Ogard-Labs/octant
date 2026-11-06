import { Schema } from "effect";
import {
  browserSelectMenuEntries,
  HumanBrowserPagePopup,
  MAX_BROWSER_SELECT_MENU_ENTRIES,
  MAX_BROWSER_SELECT_OPTIONS,
} from "@octant/contracts/browser-presentation";
import { BROWSER_EDITABLE_WORLD_ID } from "./browserEditableObservation";

type Evaluate = (
  world: number,
  scripts: ReadonlyArray<{ readonly code: string }>,
) => Promise<unknown>;
type SelectPopup = Extract<HumanBrowserPagePopup, { kind: "select" }>;
export type BrowserHeldSelect =
  | ({
      readonly status: "held";
      readonly token: string;
      /** How long ago, in milliseconds, the page held the press. */
      readonly age: number;
    } & Omit<SelectPopup, "kind" | "id">)
  | { readonly status: "too-many"; readonly token: string };

const Token = Schema.UUID;
const decodePopup = Schema.decodeUnknownSync(HumanBrowserPagePopup);
const decodeTooMany = Schema.decodeUnknownSync(
  Schema.Struct({ token: Token, tooMany: Schema.Literal(true) }),
  { onExcessProperty: "error" },
);
const READ = `(() => {
  const bridge = globalThis.octantBrowserSelect;
  return bridge && typeof bridge.read === "function" ? bridge.read() : null;
})()`;

async function bounded(evaluate: Evaluate, code: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluate(BROWSER_EDITABLE_WORLD_ID, [{ code }]),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), 500);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the select list a trusted press held, decoded to the presentation bound. */
export async function readBrowserHeldSelect(
  evaluate: Evaluate,
): Promise<BrowserHeldSelect | undefined> {
  const value = await bounded(evaluate, READ);
  if (typeof value !== "object" || value === null) return undefined;
  try {
    if ("tooMany" in value) return { status: "too-many", token: decodeTooMany(value).token };
    const { token, age, ...rest } = value as { readonly token?: unknown; readonly age?: unknown };
    if (typeof age !== "number" || !Number.isFinite(age) || age < 0) return undefined;
    const options = (rest as { readonly options?: unknown }).options;
    // A list too long for one native menu is refused as too many, never cut short.
    if (
      typeof token === "string" &&
      Array.isArray(options) &&
      options.every(
        (option: unknown) =>
          typeof option === "object" &&
          option !== null &&
          (!("group" in option) || typeof option.group === "string"),
      ) &&
      browserSelectMenuEntries(options as ReadonlyArray<{ readonly group?: string }>) >
        MAX_BROWSER_SELECT_MENU_ENTRIES
    )
      return { status: "too-many", token: Schema.decodeUnknownSync(Token)(token) };
    const popup = decodePopup({
      kind: "select",
      id: typeof token === "string" ? token : "",
      ...rest,
    });
    if (popup.kind !== "select" || popup.options.length > MAX_BROWSER_SELECT_OPTIONS)
      return undefined;
    const { kind: _kind, id, ...held } = popup;
    return { status: "held", token: String(id), age, ...held };
  } catch {
    return undefined;
  }
}

export async function answerBrowserHeldSelect(
  evaluate: Evaluate,
  token: string,
  index: number,
): Promise<boolean> {
  return (
    (await bounded(
      evaluate,
      `globalThis.octantBrowserSelect?.answer(${JSON.stringify(token)}, ${String(index)}) === true`,
    )) === true
  );
}

export async function dismissBrowserHeldSelect(evaluate: Evaluate, token: string): Promise<void> {
  await bounded(evaluate, `globalThis.octantBrowserSelect?.dismiss(${JSON.stringify(token)})`);
}
