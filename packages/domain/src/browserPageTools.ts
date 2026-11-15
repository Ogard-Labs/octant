/**
 * Tools a page declares for agents.
 *
 * Octant reads the declarative form of the WebMCP proposal: a `<form>` that
 * carries `toolname` and `tooldescription` is one tool, each named control of
 * that form is one parameter (described by its `toolparamdescription`), and
 * `toolautosubmit` says the page lets an agent submit it. The imperative
 * registry (`document.modelContext`) is not read: it ships in Chromium only
 * behind an origin trial or a testing flag that neither of Octant's Browsers
 * enables, so on a page there it is simply absent.
 *
 * `readBrowserPageTools` runs inside the page, as `readBrowserPage` does, so it
 * stays self-contained: no imports and no helpers outside its body. What it
 * returns is the page's word and is bounded again on the server by
 * `boundBrowserPageTools` before anything reaches the agent.
 */

import type {
  BrowserPageDeclaredTool,
  BrowserPageDeclaredTools,
  BrowserPageToolCall,
  BrowserPageToolParameter,
} from "@octant/contracts";
import {
  BROWSER_CREDENTIAL_HINT_ATTRIBUTES,
  BROWSER_CREDENTIAL_HINT_SOURCE,
} from "./browserPageSnapshot";
import {
  MAX_BROWSER_PAGE_TOOL_CHOICES,
  MAX_BROWSER_PAGE_TOOL_DESCRIPTION_CHARACTERS,
  MAX_BROWSER_PAGE_TOOL_PARAMETER_DESCRIPTION_CHARACTERS,
  MAX_BROWSER_PAGE_TOOL_PARAMETERS,
  MAX_BROWSER_PAGE_TOOLS,
} from "@octant/contracts";

/**
 * The snapshot reader's credential hint, handed in because the reader runs in
 * the page and cannot import it; one pattern decides for every Browser reader.
 */
interface BrowserPageToolsCredentialHint {
  readonly credentialHint: string;
  readonly credentialAttributes: ReadonlyArray<string>;
}

export type BrowserPageToolsRequest = BrowserPageToolsCredentialHint &
  (
    | {
        readonly mode: "list";
        readonly maxTools: number;
        readonly maxParameters: number;
        readonly maxChoices: number;
      }
    | { readonly mode: "call"; readonly call: BrowserPageToolCall }
  );

const CREDENTIAL_HINT: BrowserPageToolsCredentialHint = {
  credentialHint: BROWSER_CREDENTIAL_HINT_SOURCE,
  credentialAttributes: BROWSER_CREDENTIAL_HINT_ATTRIBUTES,
};

export type BrowserPageToolsResult =
  | {
      readonly mode: "list";
      readonly tools: ReadonlyArray<unknown>;
      readonly truncated: boolean;
      readonly withheld: number;
    }
  | { readonly mode: "call"; readonly status: "submitted" | "filled-for-person" }
  | { readonly mode: "call"; readonly status: "refused"; readonly reason: BrowserPageToolRefusal };

/** Why a declared tool's call did not run in the page. */
export type BrowserPageToolRefusal =
  | "not-declared"
  | "declared-twice"
  | "credential-field"
  | "unknown-parameter"
  | "invalid-value"
  | "invalid-form";

/** The bounds both runtimes hand the in-page reader. */
export const BROWSER_PAGE_TOOLS_LIST_REQUEST: BrowserPageToolsRequest = {
  ...CREDENTIAL_HINT,
  mode: "list",
  maxTools: MAX_BROWSER_PAGE_TOOLS,
  maxParameters: MAX_BROWSER_PAGE_TOOL_PARAMETERS,
  maxChoices: MAX_BROWSER_PAGE_TOOL_CHOICES,
};

/** The request both runtimes hand the in-page reader to call one declared tool. */
export function browserPageToolCallRequest(call: BrowserPageToolCall): BrowserPageToolsRequest {
  return { ...CREDENTIAL_HINT, mode: "call", call };
}

/**
 * Runs inside the page. See the module comment: nothing outside this body is
 * reachable once the source is handed to the page.
 */
export function readBrowserPageTools(request: BrowserPageToolsRequest): BrowserPageToolsResult {
  // The snapshot reader's hint for a field that holds a secret, matched
  // against the same attributes, its accessible label included.
  const credentialHint = new RegExp(request.credentialHint);
  const skippedTypes = new Set(["hidden", "submit", "button", "reset", "image", "file"]);
  const isCredential = (element: Element): boolean => {
    if (element instanceof HTMLInputElement && element.type === "password") return true;
    const words = [
      element.getAttribute("type"),
      ...request.credentialAttributes.map((attribute) => element.getAttribute(attribute)),
    ]
      .filter((word): word is string => word !== null)
      .join(" ")
      .toLowerCase();
    return credentialHint.test(words);
  };
  const controlsOf = (form: HTMLFormElement): ReadonlyArray<Element> =>
    Array.from(form.elements).filter((element) => {
      const name = element.getAttribute("name");
      if (name === null || name === "") return false;
      if (element instanceof HTMLInputElement) return !skippedTypes.has(element.type);
      return element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
    });
  const holdsCredential = (form: HTMLFormElement): boolean =>
    Array.from(form.elements).some(isCredential);
  const forms = Array.from(document.querySelectorAll("form[toolname]")).filter(
    (form): form is HTMLFormElement => form instanceof HTMLFormElement,
  );
  if (request.mode === "list") {
    const tools: unknown[] = [];
    let truncated = false;
    let withheld = 0;
    for (const form of forms) {
      const name = (form.getAttribute("toolname") ?? "").trim();
      if (name === "") continue;
      if (holdsCredential(form)) {
        withheld += 1;
        continue;
      }
      if (tools.length >= request.maxTools) {
        truncated = true;
        continue;
      }
      const parameters = new Map<string, Record<string, unknown>>();
      for (const control of controlsOf(form)) {
        const paramName = control.getAttribute("name") ?? "";
        const described = control.getAttribute("toolparamdescription");
        const existing = parameters.get(paramName);
        if (control instanceof HTMLInputElement && control.type === "radio") {
          if (existing !== undefined) {
            const choices = existing.choices;
            if (Array.isArray(choices) && choices.length < request.maxChoices)
              choices.push(control.value);
            if (control.required) existing.required = true;
            continue;
          }
        } else if (existing !== undefined) continue;
        if (parameters.size >= request.maxParameters) {
          truncated = true;
          continue;
        }
        const required =
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
            ? control.required
            : false;
        const entry: Record<string, unknown> = {
          name: paramName,
          type: "text",
          required,
          ...(described === null ? {} : { description: described }),
        };
        if (control instanceof HTMLInputElement) {
          if (control.type === "checkbox") entry.type = "boolean";
          else if (control.type === "number" || control.type === "range") entry.type = "number";
          else if (control.type === "radio") {
            entry.type = "choice";
            entry.choices = [control.value];
          }
        } else if (control instanceof HTMLSelectElement) {
          entry.type = "choice";
          entry.choices = Array.from(control.options)
            .slice(0, request.maxChoices)
            .map((option) => option.value);
        }
        parameters.set(paramName, entry);
      }
      tools.push({
        name,
        description: form.getAttribute("tooldescription") ?? "",
        autosubmit: form.hasAttribute("toolautosubmit"),
        parameters: [...parameters.values()],
      });
    }
    return { mode: "list", tools, truncated, withheld };
  }
  const refuse = (reason: BrowserPageToolRefusal): BrowserPageToolsResult => ({
    mode: "call",
    status: "refused",
    reason,
  });
  const matching = forms.filter(
    (form) => (form.getAttribute("toolname") ?? "").trim() === request.call.name,
  );
  const form = matching[0];
  if (form === undefined) return refuse("not-declared");
  if (matching.length > 1) return refuse("declared-twice");
  if (holdsCredential(form)) return refuse("credential-field");
  const controls = controlsOf(form);
  const announce = (element: Element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // The prototype's own setter, so a page that tracks its fields' values sees
  // the change as it would a person's typing.
  const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    if (setter === undefined) element.value = value;
    else setter.call(element, value);
  };
  for (const [key, value] of Object.entries(request.call.arguments)) {
    const named = controls.filter((control) => control.getAttribute("name") === key);
    const first = named[0];
    if (first === undefined) return refuse("unknown-parameter");
    if (first instanceof HTMLInputElement && first.type === "radio") {
      const chosen = named.find(
        (control) => control instanceof HTMLInputElement && control.value === String(value),
      );
      if (!(chosen instanceof HTMLInputElement)) return refuse("invalid-value");
      chosen.checked = true;
      announce(chosen);
    } else if (first instanceof HTMLInputElement && first.type === "checkbox") {
      if (typeof value !== "boolean") return refuse("invalid-value");
      first.checked = value;
      announce(first);
    } else if (first instanceof HTMLSelectElement) {
      const option = Array.from(first.options).find((entry) => entry.value === String(value));
      if (option === undefined) return refuse("invalid-value");
      first.value = option.value;
      announce(first);
    } else if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) {
      setValue(first, String(value));
      announce(first);
    } else return refuse("unknown-parameter");
  }
  if (!form.hasAttribute("toolautosubmit")) {
    // The page asked for the person to review and submit this form, so the
    // filled form waits for them with its submit control focused.
    const submit = form.querySelector('button:not([type]), [type="submit"]');
    if (submit instanceof HTMLElement) submit.focus();
    return { mode: "call", status: "filled-for-person" };
  }
  if (!form.checkValidity()) return refuse("invalid-form");
  form.requestSubmit();
  return { mode: "call", status: "submitted" };
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function clip(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * The page's declaration, bounded and checked on the server. The in-page
 * reader already bounds it, but its answer is the page's word: a page can
 * replace the reader's intrinsics, so the shape and every bound are enforced
 * again here. A tool or parameter whose name is not a plain identifier is
 * dropped and counted as truncated; nothing is renamed.
 */
export function boundBrowserPageTools(reading: unknown): BrowserPageDeclaredTools | undefined {
  if (typeof reading !== "object" || reading === null) return undefined;
  const record = reading as Record<string, unknown>;
  if (record.mode !== "list" || !Array.isArray(record.tools)) return undefined;
  let truncated = record.truncated === true;
  const tools: BrowserPageDeclaredTool[] = [];
  const seen = new Set<string>();
  for (const raw of record.tools) {
    if (tools.length >= MAX_BROWSER_PAGE_TOOLS) {
      truncated = true;
      break;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const tool = raw as Record<string, unknown>;
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name) || seen.has(tool.name)) {
      truncated = true;
      continue;
    }
    seen.add(tool.name);
    const parameters: BrowserPageToolParameter[] = [];
    for (const rawParameter of Array.isArray(tool.parameters) ? tool.parameters : []) {
      if (parameters.length >= MAX_BROWSER_PAGE_TOOL_PARAMETERS) {
        truncated = true;
        break;
      }
      if (typeof rawParameter !== "object" || rawParameter === null) continue;
      const parameter = rawParameter as Record<string, unknown>;
      const type = parameter.type;
      if (
        typeof parameter.name !== "string" ||
        !TOOL_NAME.test(parameter.name) ||
        (type !== "text" && type !== "number" && type !== "boolean" && type !== "choice")
      ) {
        truncated = true;
        continue;
      }
      const description = clip(
        parameter.description,
        MAX_BROWSER_PAGE_TOOL_PARAMETER_DESCRIPTION_CHARACTERS,
      );
      const choices =
        type === "choice" && Array.isArray(parameter.choices)
          ? parameter.choices.slice(0, MAX_BROWSER_PAGE_TOOL_CHOICES).flatMap((choice) => {
              const bounded = typeof choice === "string" ? choice.slice(0, 128) : undefined;
              return bounded === undefined ? [] : [bounded];
            })
          : undefined;
      parameters.push({
        name: parameter.name,
        type,
        required: parameter.required === true,
        ...(description === undefined || description === "" ? {} : { description }),
        ...(choices === undefined ? {} : { choices }),
      });
    }
    tools.push({
      name: tool.name,
      description: clip(tool.description, MAX_BROWSER_PAGE_TOOL_DESCRIPTION_CHARACTERS) ?? "",
      autosubmit: tool.autosubmit === true,
      parameters,
    });
  }
  const withheld =
    typeof record.withheld === "number" && Number.isSafeInteger(record.withheld)
      ? Math.min(Math.max(record.withheld, 0), 1024)
      : 0;
  return { tools, truncated, withheld };
}

/**
 * Whether a declared tool's call is one the Full access rule's closed list
 * covers: paying, buying, or sending a message as the person. The list is not
 * widened here; this only recognises its existing entry in what the page
 * declared (the tool's name, its description, and its parameters' names and
 * descriptions), so such a call still asks at Full access.
 *
 * The words are the page's own, so a page that hides a payment behind a bland
 * name is not caught; the same is true of a button labelled to mislead. The
 * site approval and the credential-field rule hold either way.
 */
export function browserPageToolCallPaysBuysOrSends(tool: BrowserPageDeclaredTool): boolean {
  const text = [
    tool.name,
    tool.description,
    ...tool.parameters.flatMap((parameter) => [parameter.name, parameter.description ?? ""]),
  ]
    .join(" ")
    // Split identifiers such as `sendMessage` and `place_order` into words.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .toLowerCase();
  return CLOSED_LIST_WORDS.test(text);
}

const CLOSED_LIST_WORDS =
  /\b(?:pay|pays|paying|payment|payments|purchase|purchases|purchasing|buy|buys|buying|checkout|check out|place order|order now|donate|donation|card number|cvv|cvc|send|sends|sending|message|messages|email|e-mail|mail|sms|dm|post|publish|tweet|reply|comment)\b/;
