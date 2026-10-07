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
 * need to catch every spelling of a script, because none of them run.
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

/**
 * Why a frame's markup cannot be drawn as written, or `undefined` when it can.
 * The reason names the construct so the author can rewrite it.
 */
export function canvasDesignMarkupRefusal(markup: string): string | undefined {
  for (const tag of startTags(markup)) {
    const name = elementName(tag.name);
    if (REFUSED_ELEMENTS.has(name)) {
      return `uses a <${name}> element; design frames run no script and load no other document.`;
    }
    const refusal = attributeRefusal(tag.attributes);
    if (refusal !== undefined) return refusal;
  }
  if (ANY_OUTSIDE_LINK.test(markup)) {
    return 'has a link that leaves the design; a link may only name a frame or a section, such as href="#checkout".';
  }
  return cssRefusal(markup);
}

/**
 * Why a shared stylesheet cannot be used as written, or `undefined`. It is
 * written into each frame inside one style element, so it must not be able to
 * close that element and start markup of its own.
 */
export function canvasDesignStylesheetRefusal(styles: string): string | undefined {
  if (/<\/style/i.test(styles)) return "closes its own style element.";
  return cssRefusal(styles);
}

function cssRefusal(raw: string): string | undefined {
  const css = withoutCssEscapes(raw);
  if (/@import\b/i.test(css)) {
    return "imports a stylesheet; put every style in the design itself.";
  }
  for (const match of css.matchAll(CSS_URL)) {
    const target = (match[1] ?? "").toLowerCase();
    if (!target.startsWith("data:") && !target.startsWith("#")) {
      return "loads a file with url(); use a data: URL, an inline SVG, or a gradient.";
    }
  }
  return undefined;
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
function withoutCssEscapes(css: string): string {
  return css.replace(CSS_ESCAPE, (_escape, hex: string | undefined, other: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return String.fromCodePoint(valid ? code : 0xfffd);
    }
    return other === undefined || /[\n\r\f]/.test(other) ? "" : other;
  });
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

function attributeRefusal(attributes: string): string | undefined {
  for (const attribute of attributes.matchAll(ATTRIBUTE)) {
    const name = (attribute[1] ?? "").toLowerCase();
    const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim();
    // `open` (a details element shown expanded) is the one attribute that
    // starts like an event handler and is not one.
    if (/^on[a-z]+$/.test(name) && name !== "open") {
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
      const remote = addresses.find((address) => !address.toLowerCase().startsWith("data:image/"));
      if (remote !== undefined) {
        return `loads "${truncated(remote)}"; images must be data:image URLs or inline SVG.`;
      }
    }
    if (REFUSED_ATTRIBUTES.has(name)) {
      return `has a ${name} attribute; design frames send nothing anywhere.`;
    }
  }
  return undefined;
}

function truncated(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 47)}…`;
}
