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
 * This reads markup with patterns, not a parser. It does not need to catch
 * every spelling of a script, because none of them run.
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

const TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const FRAGMENT = /^#[A-Za-z0-9._:-]*$/;
// A backstop for links inside a tag the pattern above could not close, such
// as one with an unterminated quote, which a browser still turns into a link.
const ANY_OUTSIDE_LINK = /[\s/"'](?:xlink:)?href\s*=\s*(?:["']\s*)?[^#"'\s>]/i;
const CSS_URL = /url\(\s*["']?\s*([^"')\s]*)/gi;

/**
 * Why a frame's markup cannot be drawn as written, or `undefined` when it can.
 * The reason names the construct so the author can rewrite it.
 */
export function canvasDesignMarkupRefusal(markup: string): string | undefined {
  for (const tag of markup.matchAll(TAG)) {
    const name = elementName(tag[1] ?? "");
    if (REFUSED_ELEMENTS.has(name)) {
      return `uses a <${name}> element; design frames run no script and load no other document.`;
    }
    const refusal = attributeRefusal(tag[2] ?? "");
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

function cssRefusal(css: string): string | undefined {
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
    if (SOURCE_ATTRIBUTES.has(name) && !value.toLowerCase().startsWith("data:image/")) {
      return `loads "${truncated(value)}"; images must be data:image URLs or inline SVG.`;
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
