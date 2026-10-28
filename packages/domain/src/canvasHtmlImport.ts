import {
  CANVAS_HTML_IMPORT_DROP_EXAMPLES,
  CANVAS_HTML_IMPORT_DROP_EXAMPLE_MAX_CHARS,
  CANVAS_HTML_IMPORT_MAX_BYTES,
  type CanvasHtmlImportDrop,
  type CanvasHtmlImportDropKind,
  type CanvasHtmlImportFrame,
  type CanvasHtmlImportRefusalReason,
} from "@octant/contracts/canvas-cards";
import {
  CANVAS_MAX_DESIGN_MARKUP_LENGTH,
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasDesignBlock,
} from "@octant/contracts/canvas";
import { canvasDesignMarkupRefusal, canvasDesignStylesheetRefusal } from "./canvasDesignPolicy";

/**
 * Turns an HTML page a person brought (a file or pasted markup) into one
 * `design` block.
 *
 * The page becomes a `document`-size design in its own look (`theme: "none"`),
 * so it is as wide as the Canvas and as tall as its content. Its tier is read
 * the way the design policy reads any design: a page that still holds an
 * inline script or an event handler is a design that runs script, and every
 * other page is a static frame. The import never chooses a looser tier.
 *
 * A design frame loads nothing and leaves nothing, so the import takes out
 * what the page would fetch or where it would go: script files, stylesheets
 * and `@import`s, images, fonts, and media that are not inline, links out of
 * the page, embedded pages, form destinations, `meta`, `base`, and `link`
 * elements, and SVG animation (which can rewrite a link after it is checked).
 * Each is counted with a few examples so the person is told what is missing.
 * Comments are dropped: they draw nothing, and the design policy reads prose
 * for loads.
 *
 * This is a light left-to-right scan, not a parser, like the design policy.
 * It need not be exact, because the result is checked afterwards by that same
 * policy: anything the scan misreads is refused there (`unsupported`), never
 * drawn under a looser rule.
 */

export type CanvasHtmlImport =
  | {
      readonly status: "imported";
      readonly block: CanvasDesignBlock;
      readonly frame: CanvasHtmlImportFrame;
      readonly dropped: ReadonlyArray<CanvasHtmlImportDrop>;
      /** The page's own `<title>`, when it has one. */
      readonly pageTitle?: string;
    }
  | {
      readonly status: "refused";
      readonly reason: CanvasHtmlImportRefusalReason;
      readonly message: string;
    };

const DROP_ORDER: ReadonlyArray<CanvasHtmlImportDropKind> = [
  "script-file",
  "stylesheet",
  "file",
  "link",
  "embedded-document",
  "form-target",
  "page-setting",
  "svg-animation",
];

/** Elements whose page or plugin the frame would load; dropped with what they hold. */
const EMBEDDED_ELEMENTS = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
]);
/** Elements a browser reads as text until their own end tag; kept as written. */
const RAW_TEXT_ELEMENTS = new Set(["textarea", "xmp", "noembed", "noframes"]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Elements whose `href` loads a file rather than naming a place to go. */
const HREF_LOADS = new Set(["image", "feimage", "use"]);
const SOURCE_ATTRIBUTES = new Set(["src", "poster", "background"]);
const SEND_ATTRIBUTES = new Set(["action", "formaction", "ping"]);
// The same reading of an attribute as the design policy's.
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// A link that names a frame or a section, as the design policy admits.
const FRAGMENT = /^#[A-Za-z0-9._:-]+$/;
const SRCSET_CANDIDATE = /(?:^|,)\s*([^\s,]\S*)/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["']?)([^"');\s]*)\1[^;]*;?/gi;
const CSS_URL_CALL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;

interface Attribute {
  readonly name: string;
  readonly lower: string;
  /** As written, character references unresolved; absent for a bare attribute. */
  readonly value: string | undefined;
}

interface Tag {
  readonly closing: boolean;
  /** Lower case, prefix and all, as the end tag must match it. */
  readonly name: string;
  /** Lower case, after any prefix: what the element is. */
  readonly local: string;
  readonly attributes: ReadonlyArray<Attribute>;
  readonly selfClosing: boolean;
  /** Index just past the tag's `>`. */
  readonly end: number;
}

class Unparseable extends Error {}

export function importCanvasHtmlPage(
  html: string,
  options: { readonly title?: string } = {},
): CanvasHtmlImport {
  if (new TextEncoder().encode(html).byteLength > CANVAS_HTML_IMPORT_MAX_BYTES) {
    return refusal(
      "too-large",
      `This page is larger than ${formatBytes(CANVAS_HTML_IMPORT_MAX_BYTES)}, the most Octant imports.`,
    );
  }
  // Text decoded from an image, archive, or other binary file holds NUL.
  if (html.includes("\u0000") || !/<[A-Za-z]/.test(html)) {
    return refusal("not-html", "This is not an HTML page: it holds no HTML elements.");
  }
  let page: ReadPage;
  try {
    page = readPage(html);
  } catch (error) {
    if (error instanceof Unparseable) return refusal("unparseable", error.message);
    throw error;
  }
  const markup = page.markup.trim();
  const styles = page.styles.trim();
  if (markup.length === 0) {
    return refusal("empty", "This page has nothing to draw once what it loads is taken out.");
  }
  if (
    markup.length > CANVAS_MAX_DESIGN_MARKUP_LENGTH ||
    styles.length > CANVAS_MAX_DESIGN_MARKUP_LENGTH
  ) {
    return refusal(
      "too-large",
      `This page is ${formatCount(markup.length)} characters of markup and ${formatCount(styles.length)} of styles once what it loads is taken out; one design holds ${formatCount(CANVAS_MAX_DESIGN_MARKUP_LENGTH)} of each.`,
    );
  }
  const runsScript = page.runsScript;
  const refused =
    (styles.length === 0 ? undefined : canvasDesignStylesheetRefusal(styles)) ??
    canvasDesignMarkupRefusal(markup, new Set(), runsScript);
  if (refused !== undefined) {
    return refusal("unsupported", `Octant cannot draw this page as a design: it ${refused}`);
  }
  const title = page.title ?? shortened(options.title?.trim() ?? "", CANVAS_MAX_MOCKUP_TEXT_LENGTH);
  const block = decodeCanvasBlock({
    blockId: "imported-page",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "design",
    title: title.length === 0 ? "Imported page" : title,
    size: "document",
    theme: "none",
    ...(runsScript ? { runsScript: true } : {}),
    ...(styles.length === 0 ? {} : { styles }),
    frames: [{ frameId: "page", title: "Page", html: markup }],
  });
  if (block.kind !== "design") throw new Error("An imported page decoded as another block.");
  return {
    status: "imported",
    block,
    frame: runsScript ? "running" : "static",
    dropped: page.dropped,
    ...(page.title === undefined ? {} : { pageTitle: page.title }),
  };
}

interface ReadPage {
  readonly markup: string;
  readonly styles: string;
  readonly runsScript: boolean;
  readonly title: string | undefined;
  readonly dropped: ReadonlyArray<CanvasHtmlImportDrop>;
}

/**
 * One pass over the page. What the head keeps (inline script) goes ahead of
 * the body, as it ran first; the body's own look and handlers move to a
 * wrapping element and a load listener, because the host writes the frame's
 * real `body`.
 */
function readPage(html: string): ReadPage {
  const lower = html.toLowerCase();
  const drops = new Map<CanvasHtmlImportDropKind, { count: number; examples: string[] }>();
  const drop = (kind: CanvasHtmlImportDropKind, example?: string) => {
    const entry = drops.get(kind) ?? { count: 0, examples: [] };
    entry.count += 1;
    const shown = example === undefined ? "" : dropExample(example);
    if (
      shown.length > 0 &&
      entry.examples.length < CANVAS_HTML_IMPORT_DROP_EXAMPLES &&
      !entry.examples.includes(shown)
    ) {
      entry.examples.push(shown);
    }
    drops.set(kind, entry);
  };
  const head: string[] = [];
  const beforeBody: string[] = [];
  const body: string[] = [];
  const styles: string[] = [];
  let title: string | undefined;
  let inHead = false;
  let bodyOpened = false;
  let bodyAttributes: ReadonlyArray<Attribute> = [];
  let foreign = 0;
  let runsScript = false;
  const emit = (text: string) => {
    if (inHead) {
      if (text.trim().length > 0) head.push(text);
    } else {
      (bodyOpened ? body : beforeBody).push(text);
    }
  };
  /** Index just past the end tag that closes a text-only element, or a refusal. */
  const textEnd = (
    name: string,
    from: number,
  ): { readonly close: number; readonly after: number } => {
    const close = new RegExp(`</${name}(?=[\\s/>]|$)`, "g");
    close.lastIndex = from;
    const found = close.exec(lower);
    if (found === null) throw new Unparseable(`A <${name}> element in this page never ends.`);
    const gt = lower.indexOf(">", found.index);
    return { close: found.index, after: gt === -1 ? html.length : gt + 1 };
  };

  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      emit(html.slice(cursor));
      break;
    }
    if (open > cursor) emit(html.slice(cursor, open));
    if (lower.startsWith("<!--", open)) {
      const end = lower.indexOf("-->", open + 4);
      if (end === -1) throw new Unparseable("A comment in this page never ends.");
      cursor = end + 3;
      continue;
    }
    if (foreign > 0 && lower.startsWith("<![cdata[", open)) {
      const end = lower.indexOf("]]>", open);
      if (end === -1) throw new Unparseable("A CDATA section in this page never ends.");
      emit(html.slice(open, end + 3));
      cursor = end + 3;
      continue;
    }
    const tag = readTag(html, open);
    if (tag === undefined) {
      // `<!doctype>`, `<?xml?>`, and `</ ...>` draw nothing; any other `<` is text.
      const next = html.charAt(open + 1);
      if (next === "!" || next === "?" || next === "/") {
        const end = html.indexOf(">", open);
        if (end === -1) throw new Unparseable("A tag in this page never ends.");
        cursor = end + 1;
      } else {
        emit("<");
        cursor = open + 1;
      }
      continue;
    }
    cursor = tag.end;
    const name = tag.local;

    if (tag.closing) {
      if (name === "head") inHead = false;
      else if (name === "html" || name === "body") {
        // The host writes the frame's own html and body.
      } else if (VOID_ELEMENTS.has(name) || isDroppedElement(name)) {
        // Nothing was opened for it.
      } else {
        if ((name === "svg" || name === "math") && foreign > 0) foreign -= 1;
        emit(`</${tag.name}>`);
      }
      continue;
    }

    if (name === "html") continue;
    if (name === "head") {
      inHead = !bodyOpened;
      continue;
    }
    if (name === "body") {
      inHead = false;
      if (!bodyOpened) {
        bodyOpened = true;
        bodyAttributes = tag.attributes;
      }
      continue;
    }
    if (foreign === 0 && name === "title") {
      const { close, after } = textEnd("title", cursor);
      title ??= pageTitle(html.slice(cursor, close));
      cursor = after;
      continue;
    }
    if (foreign === 0 && name === "style") {
      const { close, after } = textEnd("style", cursor);
      const media = attributeValue(tag.attributes, "media");
      const css = cssWithoutLoads(html.slice(cursor, close), drop);
      styles.push(
        media === undefined || /^\s*(?:all|screen)?\s*$/i.test(media)
          ? css
          : `@media ${media} {\n${css}\n}`,
      );
      cursor = after;
      continue;
    }
    if (name === "script") {
      const { close, after } = tag.selfClosing
        ? { close: cursor, after: cursor }
        : textEnd(tag.name, cursor);
      const source =
        attributeValue(tag.attributes, "src") ??
        attributeValue(tag.attributes, "href") ??
        attributeValue(tag.attributes, "xlink:href");
      if (source !== undefined) {
        drop("script-file", source);
      } else {
        runsScript = true;
        emit(`<${tag.name}${keptAttributes(tag, drop)}>${html.slice(cursor, close)}</${tag.name}>`);
      }
      cursor = after;
      continue;
    }
    if (EMBEDDED_ELEMENTS.has(name)) {
      drop(
        "embedded-document",
        attributeValue(tag.attributes, "src") ?? attributeValue(tag.attributes, "data") ?? name,
      );
      if (!VOID_ELEMENTS.has(name) && !tag.selfClosing) {
        cursor =
          name === "iframe" ? textEnd("iframe", cursor).after : elementEnd(lower, tag.name, cursor);
      }
      continue;
    }
    if (name === "set" || name === "animate") {
      drop("svg-animation", attributeValue(tag.attributes, "attributename") ?? name);
      if (!tag.selfClosing) cursor = elementEnd(lower, tag.name, cursor);
      continue;
    }
    if (name === "meta") {
      // The host writes the frame's own charset and viewport, so dropping the
      // page's is not worth telling anyone about.
      const setting =
        attributeValue(tag.attributes, "name") ??
        attributeValue(tag.attributes, "http-equiv") ??
        attributeValue(tag.attributes, "property");
      const charset = attributeValue(tag.attributes, "charset") !== undefined;
      if (!charset && setting?.trim().toLowerCase() !== "viewport")
        drop("page-setting", setting ?? "meta");
      continue;
    }
    if (name === "base") {
      drop("page-setting", "base");
      continue;
    }
    if (name === "link") {
      const rel = (attributeValue(tag.attributes, "rel") ?? "").trim().toLowerCase();
      if (rel.split(/\s+/).includes("stylesheet")) {
        drop("stylesheet", attributeValue(tag.attributes, "href") ?? "stylesheet");
      } else {
        drop("page-setting", rel.length === 0 ? "link" : rel);
      }
      continue;
    }

    if (name === "svg" || name === "math") {
      if (!tag.selfClosing) foreign += 1;
    }
    if (foreign > 0 && name === "style") {
      const { close, after } = textEnd("style", cursor);
      emit(
        `<${tag.name}${keptAttributes(tag, drop)}>${cssWithoutLoads(html.slice(cursor, close), drop)}</${tag.name}>`,
      );
      cursor = after;
      continue;
    }
    const attributes = keptAttributes(tag, drop);
    if (tag.attributes.some(isEventHandler)) runsScript = true;
    emit(`<${tag.name}${attributes}${tag.selfClosing ? " />" : ">"}`);
    if (foreign === 0 && RAW_TEXT_ELEMENTS.has(name) && !tag.selfClosing) {
      const { close, after } = textEnd(name, cursor);
      emit(`${html.slice(cursor, close)}</${tag.name}>`);
      cursor = after;
    }
  }

  // The body's own look and listeners: its attributes on an element that
  // wraps the page, and a handler such as `onload` as a listener on the
  // window, which is what a body handler attribute listens to.
  const handlers = bodyAttributes.filter(isEventHandler);
  const look = keptAttributes(
    { attributes: bodyAttributes.filter((attribute) => !isEventHandler(attribute)), local: "div" },
    drop,
  );
  const listeners = handlers.map(
    (handler) =>
      `window.addEventListener(${JSON.stringify(handler.lower.slice(2))}, function (event) { ${withoutReferences(
        handler.value ?? "",
      ).replace(/<\/script/gi, "<\\/script")} });`,
  );
  if (listeners.length > 0) runsScript = true;
  const wrapped = look.length === 0 ? body.join("") : `<div${look}>${body.join("")}</div>`;
  const markup = [
    head.join(""),
    beforeBody.join(""),
    wrapped,
    listeners.length === 0 ? "" : `<script>${listeners.join("\n")}</script>`,
  ].join("");

  return {
    markup,
    styles: styles
      .map((css) => css.trim())
      .filter((css) => css.length > 0)
      .join("\n"),
    runsScript,
    title,
    dropped: DROP_ORDER.flatMap((kind) => {
      const entry = drops.get(kind);
      return entry === undefined ? [] : [{ kind, count: entry.count, examples: entry.examples }];
    }),
  };
}

function isDroppedElement(name: string): boolean {
  return (
    EMBEDDED_ELEMENTS.has(name) ||
    name === "title" ||
    name === "style" ||
    name === "script" ||
    name === "set" ||
    name === "animate"
  );
}

function isEventHandler(attribute: Attribute): boolean {
  // `open` (a details element shown expanded) starts like a handler and is not one.
  return /^on[a-z]+$/.test(attribute.lower) && attribute.lower !== "open";
}

/**
 * The tag that starts at `open`, or `undefined` when `<` starts no tag there.
 * A quote opens an attribute value only right after its `=`, as a browser
 * reads it; a tag left open at the end of the page refuses the page.
 */
function readTag(html: string, open: number): Tag | undefined {
  const closing = html.charAt(open + 1) === "/";
  const nameStart = closing ? open + 2 : open + 1;
  if (!/[A-Za-z]/.test(html.charAt(nameStart))) return undefined;
  let cursor = nameStart;
  while (cursor < html.length && !/[\s/>]/.test(html.charAt(cursor))) cursor += 1;
  const name = html.slice(nameStart, cursor).toLowerCase();
  const attributesStart = cursor;
  let awaitingValue = false;
  while (cursor < html.length) {
    const char = html.charAt(cursor);
    if (char === ">") break;
    if (awaitingValue && (char === '"' || char === "'")) {
      const end = html.indexOf(char, cursor + 1);
      if (end === -1) throw new Unparseable("An attribute value in this page never ends.");
      cursor = end + 1;
      awaitingValue = false;
      continue;
    }
    if (char === "=") awaitingValue = true;
    else if (!/\s/.test(char)) awaitingValue = false;
    cursor += 1;
  }
  if (cursor >= html.length) throw new Unparseable("A tag in this page never ends.");
  const raw = html.slice(attributesStart, cursor);
  const colon = name.lastIndexOf(":");
  return {
    closing,
    name,
    local: colon === -1 ? name : name.slice(colon + 1),
    attributes: closing ? [] : readAttributes(raw),
    selfClosing: /\/\s*$/.test(raw),
    end: cursor + 1,
  };
}

function readAttributes(raw: string): ReadonlyArray<Attribute> {
  return Array.from(raw.matchAll(ATTRIBUTE), (match) => {
    const name = match[1] ?? "";
    return { name, lower: name.toLowerCase(), value: match[2] ?? match[3] ?? match[4] };
  }).filter((attribute) => attribute.name !== "/");
}

function attributeValue(attributes: ReadonlyArray<Attribute>, lower: string): string | undefined {
  return attributes.find((attribute) => attribute.lower === lower)?.value;
}

/**
 * The attributes a design frame may keep, written back with double quotes.
 * Links that leave the page, sources that are not inline images, and
 * destinations a form or ping would send to are taken out and counted.
 */
function keptAttributes(
  tag: Pick<Tag, "attributes" | "local">,
  drop: (kind: CanvasHtmlImportDropKind, example?: string) => void,
): string {
  let kept = "";
  for (const attribute of tag.attributes) {
    const value = attribute.value;
    const plain = withoutReferences(value ?? "").trim();
    if (attribute.lower === "href" || attribute.lower === "xlink:href") {
      if (FRAGMENT.test(plain)) {
        kept += written(attribute.name, value);
      } else if (HREF_LOADS.has(tag.local)) {
        drop("file", plain);
      } else if (plain.length > 0 && plain !== "#" && !/^javascript:/i.test(plain)) {
        // An empty, bare `#`, or `javascript:` link goes nowhere, so taking
        // it out leaves nothing to report; the element keeps its handlers.
        drop("link", plain);
      }
      continue;
    }
    if (SOURCE_ATTRIBUTES.has(attribute.lower)) {
      if (plain.toLowerCase().startsWith("data:image/")) kept += written(attribute.name, value);
      else drop("file", plain);
      continue;
    }
    if (attribute.lower === "srcset") {
      const candidates = Array.from(plain.matchAll(SRCSET_CANDIDATE), (match) => match[1] ?? "");
      const outside = candidates.find(
        (candidate) => !candidate.toLowerCase().startsWith("data:image/"),
      );
      if (outside === undefined) kept += written(attribute.name, value);
      else drop("file", outside);
      continue;
    }
    if (SEND_ATTRIBUTES.has(attribute.lower)) {
      drop("form-target", plain.length === 0 ? attribute.lower : plain);
      continue;
    }
    if (attribute.lower === "style" && value !== undefined) {
      kept += written(attribute.name, cssWithoutLoads(value, drop));
      continue;
    }
    kept += written(attribute.name, value);
  }
  return kept;
}

function written(name: string, value: string | undefined): string {
  return value === undefined ? ` ${name}` : ` ${name}="${value.replaceAll('"', "&quot;")}"`;
}

/**
 * The CSS with every `@import` taken out and every `url()` that is not inline
 * or a fragment replaced with `none`, which leaves the rest of its rule valid
 * where a rule can take `none` and drops just that declaration elsewhere.
 */
function cssWithoutLoads(
  css: string,
  drop: (kind: CanvasHtmlImportDropKind, example?: string) => void,
): string {
  return css
    .replace(CSS_IMPORT, (_statement, _quote: string, address: string) => {
      drop("stylesheet", address);
      return "";
    })
    .replace(
      CSS_URL_CALL,
      (
        call: string,
        doubled: string | undefined,
        single: string | undefined,
        bare: string | undefined,
      ) => {
        const address = withoutReferences(doubled ?? single ?? bare ?? "")
          .trim()
          .replace(/^["']|["']$/g, "");
        const lowerAddress = address.toLowerCase();
        if (lowerAddress.startsWith("data:") || lowerAddress.startsWith("#")) return call;
        drop("file", address);
        return "none";
      },
    );
}

const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos|nbsp));?/g;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text with the common character references resolved, for reading a value or a title. */
function withoutReferences(text: string): string {
  return text.replace(
    REFERENCE,
    (reference, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED[name] ?? reference;
      const code =
        hex === undefined ? Number.parseInt(decimal ?? "", 10) : Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : "�";
    },
  );
}

function pageTitle(raw: string): string | undefined {
  const text = withoutReferences(raw).replace(/\s+/g, " ").trim();
  return text.length === 0 ? undefined : shortened(text, CANVAS_MAX_MOCKUP_TEXT_LENGTH);
}

/** The index just past the end tag that closes this element, counting ones nested in it. */
function elementEnd(lower: string, name: string, from: number): number {
  const tags = new RegExp(`<(/?)${escapeRegExp(name)}(?=[\\s/>])[^>]*>`, "g");
  tags.lastIndex = from;
  let depth = 1;
  for (let found = tags.exec(lower); found !== null; found = tags.exec(lower)) {
    const selfClosing = found[0].endsWith("/>");
    if (found[1] === "/") depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth === 0) return found.index + found[0].length;
  }
  throw new Unparseable(`A <${name}> element in this page never ends.`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An address or name as the person is shown it: a data URL by its type, everything cut short. */
function dropExample(example: string): string {
  const trimmed = example.trim();
  const data = /^data:([^;,]*)/i.exec(trimmed);
  const shown = data === null ? trimmed : `data:${data[1] ?? ""} (inline)`;
  return shortened(shown.replace(/\s+/g, " "), CANVAS_HTML_IMPORT_DROP_EXAMPLE_MAX_CHARS);
}

function shortened(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  return `${formatCount(Math.round(bytes / 1024))} KB`;
}

function refusal(reason: CanvasHtmlImportRefusalReason, message: string): CanvasHtmlImport {
  return { status: "refused", reason, message };
}
