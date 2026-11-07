import type {
  ProductFeedbackBrowserContext,
  ProductFeedbackElement,
} from "@octant/contracts/product-feedback";

export interface BrowserFeedbackElementRead {
  readonly element: Omit<
    Extract<ProductFeedbackElement, { readonly kind: "browser-element" }>,
    "kind" | "url" | "title" | "context"
  >;
  readonly context: Omit<ProductFeedbackBrowserContext, "captureId">;
  readonly cropBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly cropBlocked: boolean;
}

/**
 * Fixed host script, serialized into the document's isolated world. It reads
 * one selected element and a small structural neighborhood, never outerHTML or
 * form/editable values. The surrounding host owns origin/node/capture checks.
 */
export function readBrowserFeedbackElement(argument: {
  readonly x: number;
  readonly y: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pageX?: number;
  readonly pageY?: number;
}): BrowserFeedbackElementRead | null {
  const element = document.elementFromPoint(argument.x, argument.y);
  if (element === null || /^(?:iframe|frame)$/i.test(element.tagName)) return null;
  const tag = element.tagName.toLowerCase().slice(0, 64);
  const step = (node: Element): string => {
    const id = node.getAttribute("id");
    if (id !== null && /^[A-Za-z][\w-]{0,127}$/.test(id)) return `#${id}`;
    const name = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent === null) return name;
    let ordinal = 0;
    let count = 0;
    for (const child of parent.children) {
      if (child.tagName === node.tagName) {
        count += 1;
        if (child === node) ordinal = count;
      }
    }
    return count <= 1 ? name : `${name}:nth-of-type(${String(ordinal)})`;
  };
  const path: string[] = [];
  let parent: Element | null = element;
  while (parent !== null && path.length < 6 && parent.tagName.toLowerCase() !== "html") {
    const piece = step(parent);
    path.unshift(piece);
    if (piece.startsWith("#")) break;
    parent = parent.parentElement;
  }
  const editable = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
  const textNodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  let visited = 0;
  for (
    let node = textNodes.nextNode();
    node !== null && visited < 256 && text.length < 2_048;
    node = textNodes.nextNode()
  ) {
    visited += 1;
    if (node.parentElement?.closest(`${editable}, script, style, noscript`) !== null) continue;
    text += (node.textContent ?? "").slice(0, 2_048 - text.length);
  }
  text = text.replace(/\s+/g, " ").trim();
  const identity = (node: Element): string => {
    const role = node.getAttribute("role");
    return `${node.tagName.toLowerCase()}${role === null ? "" : ` [role=${role.slice(0, 64)}]`}`.slice(
      0,
      128,
    );
  };
  const ancestors: string[] = [];
  for (
    let node = element.parentElement;
    node !== null && ancestors.length < 4;
    node = node.parentElement
  ) {
    ancestors.push(identity(node).slice(0, 64));
  }
  const children: string[] = [];
  for (let index = 0; index < Math.min(8, element.children.length); index += 1) {
    const child = element.children.item(index);
    if (child !== null) children.push(identity(child));
  }
  const properties = [
    "display",
    "position",
    "box-sizing",
    "gap",
    "padding",
    "margin",
    "width",
    "height",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "text-align",
    "color",
    "background-color",
    "border-color",
    "border-width",
    "border-radius",
  ] as const;
  const computed = getComputedStyle(element);
  const styles = properties.map((property) => ({
    property,
    value: computed.getPropertyValue(property).slice(0, 128),
  }));
  const rect = element.getBoundingClientRect();
  const padX = Math.min(24, argument.viewportWidth * 0.05);
  const padY = Math.min(24, argument.viewportHeight * 0.05);
  const pageX = argument.pageX ?? 0;
  const pageY = argument.pageY ?? 0;
  // Inspect exactly the same viewport-clipped document rectangle the host captures.
  const cropX = Math.max(pageX, Math.floor(pageX + rect.left - padX));
  const cropY = Math.max(pageY, Math.floor(pageY + rect.top - padY));
  const right = Math.min(pageX + argument.viewportWidth, Math.ceil(pageX + rect.right + padX));
  const bottom = Math.min(pageY + argument.viewportHeight, Math.ceil(pageY + rect.bottom + padY));
  const cropBounds = {
    x: cropX,
    y: cropY,
    width: Math.max(0, right - cropX),
    height: Math.max(0, bottom - cropY),
  };
  const cropLeft = cropX - pageX;
  const cropTop = cropY - pageY;
  const cropRight = cropLeft + cropBounds.width;
  const cropBottom = cropTop + cropBounds.height;
  let cropBlocked = element.closest(editable) !== null;
  // A screenshot cannot be described as value-free merely because text was
  // filtered. Withhold it when an editable control overlaps the padded crop.
  const controls = document.querySelectorAll(`${editable}, iframe, frame, embed, object`);
  let opaqueCrop = controls.length > 256;
  if (controls.length > 256) cropBlocked = true;
  for (let index = 0; index < Math.min(256, controls.length) && !cropBlocked; index += 1) {
    const control = controls.item(index);
    if (control === null) continue;
    const box = control.getBoundingClientRect();
    if (
      box.width > 0 &&
      box.height > 0 &&
      box.right > cropLeft &&
      box.left < cropRight &&
      box.bottom > cropTop &&
      box.top < cropBottom
    ) {
      cropBlocked = true;
      opaqueCrop = /^(?:iframe|frame|embed|object)$/i.test(control.tagName);
    }
  }
  const pageElements = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  for (
    let node = pageElements.nextNode();
    node !== null && !cropBlocked;
    node = pageElements.nextNode()
  ) {
    scanned += 1;
    if (scanned > 2_048) {
      cropBlocked = true;
      opaqueCrop = true;
      break;
    }
    if (!(node instanceof Element) || (node.shadowRoot === null && !node.tagName.includes("-")))
      continue;
    const box = node.getBoundingClientRect();
    if (
      box.width > 0 &&
      box.height > 0 &&
      box.right > cropLeft &&
      box.left < cropRight &&
      box.bottom > cropTop &&
      box.top < cropBottom
    ) {
      cropBlocked = true;
      opaqueCrop = true;
    }
  }
  const name = element.getAttribute("aria-label")?.trim();
  const role = element.getAttribute("role")?.trim();
  return {
    element: {
      selector: path.length === 0 ? tag : path.join(" > ").slice(0, 1_024),
      role: (role || tag).slice(0, 64),
      ...(name === undefined || name.length === 0 ? {} : { accessibleName: name.slice(0, 512) }),
      ...(text.length === 0 ? {} : { text }),
      bounds: {
        x: Math.min(1, Math.max(0, rect.left / argument.viewportWidth)),
        y: Math.min(1, Math.max(0, rect.top / argument.viewportHeight)),
        width: Math.min(1, Math.max(0, rect.width / argument.viewportWidth)),
        height: Math.min(1, Math.max(0, rect.height / argument.viewportHeight)),
      },
    },
    context: {
      viewport: { width: argument.viewportWidth, height: argument.viewportHeight },
      tag,
      ancestors,
      children,
      styles,
      omissions: [
        "bounded-neighborhood",
        "form-values-excluded",
        "shadow-content-excluded",
        ...(opaqueCrop ? ["crop-withheld-for-uninspected-region" as const] : []),
      ],
    },
    cropBounds,
    cropBlocked,
  };
}
