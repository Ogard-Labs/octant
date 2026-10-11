import { CANVAS_DESIGN_ASSET_SCHEME } from "@octant/contracts/canvas";

/**
 * What a design frame's markup may hold.
 *
 * A design frame is drawn in a sandboxed frame with no script permission and
 * a policy that loads nothing but inline styles and `data:` images, so the
 * sandbox is the boundary. These checks exist for the author: markup that
 * needs a script, a remote file, or a link out of the design would be drawn
 * broken, so it is refused with a reason the agent can act on instead. One
 * case is more than advice: a link is the only way a sandboxed frame with no
 * script can leave the design, so every link must stay inside it.
 *
 * This reads markup with a light scan and patterns, not a parser. It does not
 * need to catch every spelling of a script, because none of them run. A remote
 * load is read the way a browser spells it, through character references and
 * CSS escapes, in a `url()`, an `@import`, or an `image-set()` candidate.
 * `url()` and `@import` are looked for across the whole markup, since a
 * presentation attribute such as `fill` can hold a `url()` too, so prose that
 * spells one out, even through a reference such as `&commat;import`, is refused
 * although a browser would only draw it as text.
 *
 * An image the design declares is named `octant-asset:<id>` where a `data:`
 * image could stand: a `src` or `srcset` candidate, a `url()`, or an
 * `image-set()` candidate. The renderer replaces each literal reference with
 * the image the host resolved before the page is drawn, so the page still
 * loads nothing. A reference is admitted only for an id the design declares,
 * and only spelled literally: a reference spelled through a character
 * reference or CSS escape is one the renderer would not replace and the
 * browser would try to load, so it is refused.
 *
 * A design that declares `runsScript` is served by the host in a frame
 * sandboxed to `allow-scripts` alone, under a policy that admits inline script
 * and still loads nothing. For it, and only for it, inline `<script>` elements
 * and event handlers are admitted; a script file, every remote load, `meta`,
 * `base`, embedded documents, and links that leave the design stay refused.
 * Script text and handler values are not read for loads: a script can build
 * any address it likes, so reading its text would only refuse honest code
 * such as `new URL(...)`, and the page's policy refuses the request anyway.
 */

/** Elements that run code, load another document, or navigate on their own. */
const REFUSED_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "meta",
  "base",
  "link",
  // SVG animation can rewrite an `href` after the checks below have read it.
  "set",
  "animate",
]);

/** Attributes that may only name a fragment inside the design: `#checkout`. */
const LINK_ATTRIBUTES = new Set(["href", "xlink:href"]);
/** Attributes that may only hold an inline `data:` image. */
const SOURCE_ATTRIBUTES = new Set(["src", "srcset", "poster", "background"]);
/** Attributes that send a request or submit somewhere. */
const REFUSED_ATTRIBUTES = new Set(["action", "formaction", "ping"]);

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// A link names a frame or a section. A bare `#` would clear the shown frame,
// so Play would fall back to the first screen rather than stay on this one.
const FRAGMENT = /^#[A-Za-z0-9._:-]+$/;
// Each candidate address of a srcset: a run without whitespace after the start
// or a comma. A data URL keeps its own commas, since it holds no whitespace.
const SRCSET_CANDIDATE = /(?:^|,)\s*([^\s,]\S*)/g;
// A backstop for links inside a tag the scan below reads differently from a
// browser, such as one with a quote in an attribute name, which a browser still
// turns into a link. Any `href` whose value does not start with `#` is refused, including an
// empty or quote-led one, which resolves against Octant's own page.
const ANY_OUTSIDE_LINK = /[\s/"'](?:xlink:)?href(?=[\s/>=]|$)(?!\s*=\s*(?:["']\s*)?#)/i;
const CSS_URL = /url\(\s*["']?\s*([^"')\s]*)/gi;

/** The asset ids a design declares; a reference to any other id is refused. */
type DeclaredAssets = ReadonlySet<string>;
const NO_ASSETS: DeclaredAssets = new Set();

/**
 * Why a frame's markup cannot be drawn as written, or `undefined` when it can.
 * The reason names the construct so the author can rewrite it.
 * `runsScript` is the design's own declaration; see the note above.
 */
export function canvasDesignMarkupRefusal(
  markup: string,
  assets: DeclaredAssets = NO_ASSETS,
  runsScript = false,
): string | undefined {
  // Script text is not markup, so a tag spelled inside a string is not read.
  const scanned = runsScript ? withoutScriptText(markup) : markup;
  for (const tag of startTags(scanned)) {
    const name = elementName(tag.name);
    if (runsScript && name === "script") {
      if (/(?:^|[\s"'/])src(?=[\s/>=]|$)/i.test(tag.attributes)) {
        return "loads a script file; write a running design's script inline.";
      }
      continue;
    }
    if (REFUSED_ELEMENTS.has(name)) {
      return runsScript
        ? `uses a <${name}> element; a running design loads no other document and sets no page policy.`
        : `uses a <${name}> element; design frames run no script and load no other document.`;
    }
    const refusal = attributeRefusal(tag.attributes, assets, runsScript);
    if (refusal !== undefined) return refusal;
  }
  if (ANY_OUTSIDE_LINK.test(scanned)) {
    return 'has a link that leaves the design; a link may only name a frame or a section, such as href="#checkout".';
  }
  const decoded = withoutCssEscapes(withoutCharacterReferences(scanned));
  const spelled = spelledAssetReferenceRefusal(scanned, decoded);
  if (spelled !== undefined) return spelled;
  const loadRefused = cssLoadRefusal(decoded, assets);
  if (loadRefused !== undefined) return loadRefused;
  // An image-set is read only inside a style element, so a quote in the prose
  // around one cannot hide its candidates. Style attributes are read above.
  for (const styles of styleElementContents(scanned)) {
    const refused = imageSetRefusal(withoutCharacterReferences(styles), assets);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

/**
 * Why a shared stylesheet cannot be used as written, or `undefined`. It is
 * written into each frame inside one style element, so it must not be able to
 * close that element and start markup of its own.
 */
export function canvasDesignStylesheetRefusal(
  styles: string,
  assets: DeclaredAssets = NO_ASSETS,
): string | undefined {
  if (/<\/style/i.test(styles)) return "closes its own style element.";
  return (
    spelledAssetReferenceRefusal(styles, withoutCssEscapes(styles)) ?? cssRefusal(styles, assets)
  );
}

function cssRefusal(raw: string, assets: DeclaredAssets): string | undefined {
  return cssLoadRefusal(withoutCssEscapes(raw), assets) ?? imageSetRefusal(raw, assets);
}

function cssLoadRefusal(css: string, assets: DeclaredAssets): string | undefined {
  if (/@import\b/i.test(css)) {
    return "imports a stylesheet; put every style in the design itself.";
  }
  for (const match of css.matchAll(CSS_URL)) {
    const refused = addressRefusal(match[1] ?? "", assets, "url()");
    if (refused !== undefined) return refused;
  }
  return undefined;
}

function imageSetRefusal(raw: string, assets: DeclaredAssets): string | undefined {
  // An escaped quote is a character of a string, never its end, so it is
  // resolved to one that the scan does not read as a quote.
  for (const address of imageSetStringCandidates(withoutCssEscapes(raw, "\ufffd"))) {
    const refused = addressRefusal(address, assets, "image-set()");
    if (refused !== undefined) return refused;
  }
  return undefined;
}

/**
 * Why one address a CSS load names would load a file, or `undefined` when it
 * is inline (`data:`), a fragment, or a declared asset.
 */
function addressRefusal(
  address: string,
  assets: DeclaredAssets,
  construct: "url()" | "image-set()",
): string | undefined {
  const target = address.trim();
  const lower = target.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("#")) return undefined;
  const asset = assetReference(target);
  if (asset !== undefined) {
    return assets.has(asset) ? undefined : undeclaredAsset(asset);
  }
  return `loads a file with ${construct}; use a data: URL, an inline SVG, a gradient, or a declared asset (octant-asset:<id>).`;
}

/**
 * The id an address names when it is exactly `octant-asset:<id>`, or
 * `undefined`. The scheme is matched as written, lower case, because that is
 * the only spelling the renderer replaces.
 */
function assetReference(address: string): string | undefined {
  if (!address.startsWith(CANVAS_DESIGN_ASSET_SCHEME)) return undefined;
  const id = address.slice(CANVAS_DESIGN_ASSET_SCHEME.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ? id : undefined;
}

function undeclaredAsset(id: string): string {
  return `uses the asset "${truncated(id)}", which the design does not declare; add it to the design's assets.`;
}

/**
 * A reference the browser would read as an asset but the renderer would not
 * replace, because a character reference or a CSS escape spells part of it.
 * Counting the scheme before and after resolving both is enough: every
 * literal reference survives resolution unchanged, so any extra one was
 * spelled.
 */
function spelledAssetReferenceRefusal(raw: string, resolved: string): string | undefined {
  const scheme = CANVAS_DESIGN_ASSET_SCHEME;
  if (resolved.split(scheme).length === raw.split(scheme).length) return undefined;
  return `spells an ${scheme} reference through a character reference or escape; write it as ${scheme}<id>.`;
}

/**
 * The quoted candidates of every `image-set()`, which a browser loads like a
 * `url()`: `image-set("https://x.test/a.png" 1x)`. A candidate starts an
 * argument of the image-set itself, so a `type("image/png")` hint inside it or
 * a quoted font family elsewhere is not one. A comment is skipped, and a string
 * a browser never closes ends at its line break. One left-to-right pass with a
 * stack of open parentheses, so a run of unclosed image-sets costs no more than
 * reading it.
 */
function imageSetStringCandidates(css: string): ReadonlyArray<string> {
  const candidates: Array<string> = [];
  // For each open parenthesis, whether it opened an image-set.
  const open: Array<boolean> = [];
  let atCandidate = false;
  let cursor = 0;
  while (cursor < css.length) {
    const char = css.charAt(cursor);
    if (char === "/" && css.charAt(cursor + 1) === "*") {
      const end = css.indexOf("*/", cursor + 2);
      cursor = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let close = cursor + 1;
      while (
        close < css.length &&
        css.charAt(close) !== char &&
        !/[\n\r\f]/.test(css.charAt(close))
      ) {
        close += 1;
      }
      if (atCandidate) candidates.push(css.slice(cursor + 1, close));
      atCandidate = false;
      cursor = close + 1;
      continue;
    }
    if (char === "(") {
      const opensImageSet =
        css.slice(Math.max(0, cursor - 9), cursor).toLowerCase() === "image-set";
      open.push(opensImageSet);
      atCandidate = opensImageSet;
    } else if (char === ")") {
      open.pop();
      atCandidate = false;
    } else if (char === ",") {
      atCandidate = open.at(-1) === true;
    } else if (!/\s/.test(char)) {
      atCandidate = false;
    }
    cursor += 1;
  }
  return candidates;
}

// A numeric character reference, which a browser resolves with or without its
// semicolon, a named one, or `&quot`, the one legacy name in the table below
// that a browser also resolves without its semicolon.
const CHARACTER_REFERENCE =
  /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&([A-Za-z][A-Za-z0-9]*);|&(quot|QUOT)/g;
// The named references for the characters the CSS checks read. No ASCII letter
// has a name, so a name can only spell the punctuation around a load.
const NAMED_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["Tab", "\t"],
  ["NewLine", "\n"],
  ["quot", '"'],
  ["QUOT", '"'],
  ["apos", "'"],
  ["lpar", "("],
  ["rpar", ")"],
  ["comma", ","],
  ["colon", ":"],
  ["num", "#"],
  ["commat", "@"],
  ["bsol", "\\"],
]);

/**
 * The markup as a browser hands it to CSS. A browser resolves character
 * references in an attribute value and in an SVG style element before it reads
 * the CSS, so `ur&#108;(` in a style attribute is `url(`. A reference this does
 * not know stays as written. One left-to-right pass, and a resolved reference
 * is not read again, as `&amp;#108;` is `&#108;` to a browser.
 */
function withoutCharacterReferences(markup: string): string {
  return markup.replace(
    CHARACTER_REFERENCE,
    (
      reference,
      hex: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
      legacy: string | undefined,
    ) => {
      const named = name ?? legacy;
      if (named !== undefined) return NAMED_CHARACTERS.get(named) ?? reference;
      const code =
        hex === undefined ? Number.parseInt(decimal ?? "", 10) : Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return String.fromCodePoint(valid ? code : 0xfffd);
    },
  );
}

// A CSS escape: a backslash and one to six hex digits with one optional
// whitespace after them, or a backslash and any other character.
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([\s\S]))/g;

/**
 * The CSS as a browser reads it once escapes are resolved. A browser reads
 * `@\69mport` as `@import` and `u\72l(` as `url(`, so the checks must too. A
 * backslash before a line break continues a string and stands for nothing.
 * One left-to-right pass, so a long run of escapes costs no more than reading it.
 */
function withoutCssEscapes(css: string, escapedQuote?: string): string {
  return css.replace(CSS_ESCAPE, (_escape, hex: string | undefined, other: string | undefined) => {
    let resolved: string;
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      resolved = String.fromCodePoint(valid ? code : 0xfffd);
    } else {
      resolved = other === undefined || /[\n\r\f]/.test(other) ? "" : other;
    }
    return escapedQuote !== undefined && (resolved === '"' || resolved === "'")
      ? escapedQuote
      : resolved;
  });
}

/**
 * The text of each style element, found with plain searches so a run of
 * unclosed ones costs no more than reading the markup. One left open runs to
 * the end of the markup, as a browser reads it.
 */
function* styleElementContents(markup: string): Generator<string> {
  const lower = markup.toLowerCase();
  let cursor = 0;
  while (cursor < markup.length) {
    const open = lower.indexOf("<style", cursor);
    if (open === -1) return;
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) return;
    const close = lower.indexOf("</style", tagEnd);
    const end = close === -1 ? markup.length : close;
    yield markup.slice(tagEnd + 1, end);
    cursor = end;
  }
}

/**
 * Each start tag's name and attribute text, read once from left to right the
 * way a browser reads them: a quote opens an attribute value only right after
 * its `=`. A single pattern that paired every quote in the markup took time
 * that grew with the square of the number of unclosed tags, about a second for
 * one 30 KB frame, and every renderer validates a Canvas when it draws one. A
 * tag still open at the end of the markup draws nothing, so the scan stops.
 */
function* startTags(
  markup: string,
): Generator<{ readonly name: string; readonly attributes: string }> {
  let cursor = 0;
  while (cursor < markup.length) {
    const open = markup.indexOf("<", cursor);
    if (open === -1) return;
    cursor = open + 1;
    if (!/[a-zA-Z]/.test(markup.charAt(cursor))) continue;
    const nameStart = cursor;
    while (cursor < markup.length && !/[\s/>]/.test(markup.charAt(cursor))) cursor += 1;
    const name = markup.slice(nameStart, cursor);
    const attributesStart = cursor;
    let awaitingValue = false;
    let closed = false;
    while (cursor < markup.length) {
      const char = markup.charAt(cursor);
      if (char === ">") {
        closed = true;
        break;
      }
      if (awaitingValue && (char === '"' || char === "'")) {
        const end = markup.indexOf(char, cursor + 1);
        if (end === -1) return;
        cursor = end + 1;
        awaitingValue = false;
        continue;
      }
      if (char === "=") awaitingValue = true;
      else if (!/\s/.test(char)) awaitingValue = false;
      cursor += 1;
    }
    if (!closed) return;
    yield { name, attributes: markup.slice(attributesStart, cursor) };
    cursor += 1;
  }
}

function elementName(raw: string): string {
  const lower = raw.toLowerCase();
  const local = lower.lastIndexOf(":");
  return local === -1 ? lower : lower.slice(local + 1);
}

function attributeRefusal(
  attributes: string,
  assets: DeclaredAssets,
  runsScript: boolean,
): string | undefined {
  for (const attribute of attributes.matchAll(ATTRIBUTE)) {
    const name = (attribute[1] ?? "").toLowerCase();
    const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim();
    // `open` (a details element shown expanded) is the one attribute that
    // starts like an event handler and is not one.
    if (/^on[a-z]+$/.test(name) && name !== "open") {
      if (runsScript) continue;
      return `has an ${name} handler; design frames run no script. Link frames with href="#frameId".`;
    }
    if (LINK_ATTRIBUTES.has(name) && !FRAGMENT.test(value)) {
      return `links to "${truncated(value)}"; a link may only name a frame or a section of this design, such as href="#checkout".`;
    }
    if (SOURCE_ATTRIBUTES.has(name)) {
      const addresses =
        name === "srcset"
          ? Array.from(value.matchAll(SRCSET_CANDIDATE), (candidate) => candidate[1] ?? "")
          : [value];
      for (const address of addresses) {
        if (address.toLowerCase().startsWith("data:image/")) continue;
        const asset = assetReference(address);
        if (asset !== undefined && assets.has(asset)) continue;
        if (asset !== undefined) return undeclaredAsset(asset);
        return `loads "${truncated(address)}"; images must be data:image URLs, inline SVG, or a declared asset (octant-asset:<id>).`;
      }
    }
    if (REFUSED_ATTRIBUTES.has(name)) {
      return `has a ${name} attribute; design frames send nothing anywhere.`;
    }
    // Read alone, a style value's own quotes are not confused with the quotes
    // around the attributes beside it.
    if (name === "style") {
      const cssRefused = cssRefusal(withoutCharacterReferences(value), assets);
      if (cssRefused !== undefined) return cssRefused;
    }
  }
  return undefined;
}

// An event handler and its value, as an attribute of a start tag.
const EVENT_HANDLER = /([\s"'/])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;

/**
 * A running design's markup with the text of each script element and the
 * value of each event handler taken out, so the load checks read only what a
 * browser would load as markup. A script element left open runs to the end
 * of the markup, as a browser reads it.
 */
function withoutScriptText(markup: string): string {
  const lower = markup.toLowerCase();
  let kept = "";
  let cursor = 0;
  while (cursor < markup.length) {
    const open = lower.indexOf("<script", cursor);
    if (open === -1) break;
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) break;
    const close = lower.indexOf("</script", tagEnd);
    kept += markup.slice(cursor, tagEnd + 1);
    cursor = close === -1 ? markup.length : close;
  }
  kept += markup.slice(cursor);
  return kept.replace(EVENT_HANDLER, "$1");
}

function truncated(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 47)}…`;
}
