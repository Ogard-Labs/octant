import {
  CANVAS_PUBLIC_SHARE_REPORT_DETAIL_MAX_CHARS,
  CANVAS_PUBLIC_SHARE_WIRE_VERSION,
  decodeCanvasPublicShareReport,
} from "@octant/contracts/canvas-public-share";
import { readLimitedBody } from "./api.ts";
import { isHttps, type ServiceContext } from "./context.ts";
import { escapeHtml as e, renderBlocks } from "./render.ts";
import { isShareId, type StoredShare } from "./store.ts";
import { mintFrameToken, mintViewGrant, viewGrantIsValid } from "./tokens.ts";
import { VIEWER_CSS } from "./viewerStyles.ts";

const COOKIE_NAME = "octant_share_view";
const FORM_BODY_MAX_BYTES = 8 * 1024;
const REPORT_REASONS: ReadonlyArray<readonly [string, string]> = [
  ["spam", "Spam"],
  ["phishing", "Phishing"],
  ["malware", "Malware"],
  ["illegal", "Illegal content"],
  ["harassment", "Harassment"],
  ["privacy", "Private information"],
  ["other", "Something else"],
];

/** Every viewer response carries these, whatever it says. */
function viewerHeaders(ctx: ServiceContext, contentType: string): Record<string, string> {
  const frameSource = new URL(ctx.usercontentOrigin).origin;
  return {
    "content-type": contentType,
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cache-control": "no-store",
    ...(isHttps(ctx.publicOrigin)
      ? { "strict-transport-security": "max-age=31536000; includeSubDomains" }
      : {}),
    "content-security-policy": `default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-src ${frameSource}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

interface PageInput {
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly body: string;
  readonly footer?: string;
}

function page(
  ctx: ServiceContext,
  input: PageInput,
  status: number,
  extra?: HeadersInit,
): Response {
  const url = `${ctx.publicOrigin}${input.path}`;
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${e(input.title)}</title>`,
    `<meta property="og:title" content="${e(input.title)}">`,
    `<meta property="og:description" content="${e(input.description)}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:url" content="${e(url)}">`,
    '<meta name="twitter:card" content="summary">',
    '<link rel="stylesheet" href="/static/viewer.css">',
    `</head><body><main>${input.body}</main><footer>${input.footer ?? ""}<p>Shared with Octant</p>${
      ctx.config.abuseContact === undefined
        ? ""
        : `<p>Abuse contact: ${e(ctx.config.abuseContact)}</p>`
    }</footer></body></html>`,
  ].join("");
  const headers = new Headers(viewerHeaders(ctx, "text/html; charset=utf-8"));
  for (const [name, value] of new Headers(extra)) headers.append(name, value);
  return new Response(html, { status, headers });
}

function notice(ctx: ServiceContext, status: number, title: string, message: string): Response {
  return page(
    ctx,
    {
      title,
      description: title,
      path: "/",
      body: `<h1>${e(title)}</h1><p>${e(message)}</p>`,
    },
    status,
  );
}

function lockedPage(ctx: ServiceContext, id: string, failed: boolean, status: number): Response {
  return page(
    ctx,
    {
      title: "Password-protected Canvas",
      description: "Password-protected Canvas",
      path: `/s/${id}`,
      body: `<h1>Password-protected Canvas</h1><p>Enter the password to view it.</p>${
        failed ? '<p class="error" role="alert">That password was not right.</p>' : ""
      }<form method="post" action="/s/${e(id)}"><label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label> <button type="submit">View</button></form>`,
    },
    status,
  );
}

function cookieValue(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

function hasViewGrant(ctx: ServiceContext, request: Request, id: string, share: StoredShare) {
  const token = cookieValue(request);
  return (
    token !== undefined &&
    viewGrantIsValid(ctx.store.frameKey(), id, share.revision, ctx.store.now(), token)
  );
}

function reportForm(id: string): string {
  const options = REPORT_REASONS.map(
    ([value, label]) => `<option value="${e(value)}">${e(label)}</option>`,
  ).join("");
  return `<details class="report"><summary>Report this Canvas</summary><form method="post" action="/s/${e(
    id,
  )}/report"><label>Reason <select name="reason">${options}</select></label><label>Details (optional) <textarea name="detail" maxlength="${String(
    CANVAS_PUBLIC_SHARE_REPORT_DETAIL_MAX_CHARS,
  )}" rows="3"></textarea></label><button type="submit">Send report</button></form></details>`;
}

function renderShare(
  ctx: ServiceContext,
  id: string,
  share: StoredShare,
  runParameter: string | null,
): Response {
  const { document } = share;
  const key = ctx.store.frameKey();
  const now = ctx.store.now();
  const runnable = document.blocks.find(
    (block) =>
      block.kind === "design" &&
      block.runsScript === true &&
      String(block.blockId) === runParameter,
  );
  const body = renderBlocks(document.blocks, {
    shareId: id,
    runBlockId: runnable === undefined ? undefined : String(runnable.blockId),
    frameAddress: (blockId, mode) =>
      `${ctx.usercontentOrigin}/f/${id}/${encodeURIComponent(blockId)}?t=${mintFrameToken(
        key,
        id,
        share.revision,
        blockId,
        mode,
        now,
      )}`,
  });
  return page(
    ctx,
    {
      title: document.title,
      description: document.summary ?? "A Canvas shared with Octant.",
      path: `/s/${id}`,
      body: `<article><h1>${e(document.title)}</h1><p class="meta">Published ${e(
        document.publishedAt.slice(0, 10),
      )}</p>${body}</article>`,
      footer: reportForm(id),
    },
    200,
  );
}

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  const body = await readLimitedBody(request, FORM_BODY_MAX_BYTES);
  return body.status === "read" ? new URLSearchParams(body.text) : undefined;
}

const GONE_MESSAGE = "This link was revoked or has expired.";

async function viewShare(
  request: Request,
  url: URL,
  ctx: ServiceContext,
  id: string,
  client: string,
): Promise<Response> {
  if (!ctx.limiter.allow("view", client)) {
    return notice(ctx, 429, "Too many requests", "Try again in a minute.");
  }
  const lookup = ctx.store.lookup(id);
  if (lookup.status === "missing") {
    return notice(ctx, 404, "Not found", "There is no Canvas at this address.");
  }
  if (lookup.status === "gone") {
    return notice(
      ctx,
      410,
      "Gone",
      lookup.tombstone.reason === "taken-down" ? "This Canvas was removed." : GONE_MESSAGE,
    );
  }
  const { share } = lookup;
  if (request.method === "POST") {
    if (share.passwordHash === null) return redirect(ctx, `/s/${id}`);
    if (!ctx.limiter.allow("password", client, id)) {
      return notice(ctx, 429, "Too many attempts", "Wait a minute before trying again.");
    }
    const form = await readForm(request);
    const password = form?.get("password") ?? "";
    const correct =
      password !== "" &&
      (await Bun.password.verify(password, share.passwordHash).catch(() => false));
    if (!correct) return lockedPage(ctx, id, true, 401);
    const grant = mintViewGrant(ctx.store.frameKey(), id, share.revision, ctx.store.now());
    return redirect(ctx, `/s/${id}`, {
      "set-cookie": `${COOKIE_NAME}=${grant}; HttpOnly; SameSite=Strict; Path=/s/${id}; Max-Age=3600${
        isHttps(ctx.publicOrigin) ? "; Secure" : ""
      }`,
    });
  }
  if (share.passwordHash !== null && !hasViewGrant(ctx, request, id, share)) {
    return lockedPage(ctx, id, false, 401);
  }
  ctx.store.recordView(id);
  return renderShare(ctx, id, share, url.searchParams.get("run"));
}

function redirect(ctx: ServiceContext, path: string, extra?: Record<string, string>): Response {
  // Never place anything but the link's own path in Location.
  return new Response(null, {
    status: 303,
    headers: { ...viewerHeaders(ctx, "text/plain; charset=utf-8"), location: path, ...extra },
  });
}

async function reportViaForm(
  request: Request,
  ctx: ServiceContext,
  id: string,
  client: string,
): Promise<Response> {
  if (!ctx.limiter.allow("report", client)) {
    return notice(ctx, 429, "Too many reports", "Try again in a minute.");
  }
  const lookup = ctx.store.lookup(id);
  if (lookup.status !== "active") {
    return notice(ctx, lookup.status === "gone" ? 410 : 404, "Not available", GONE_MESSAGE);
  }
  const form = await readForm(request);
  try {
    const detail = form?.get("detail") ?? undefined;
    const report = decodeCanvasPublicShareReport({
      schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
      kind: "canvas-public-share-report",
      reason: form?.get("reason"),
      ...(detail === undefined || detail === "" ? {} : { detail }),
    });
    ctx.store.addReport({ shareId: id, reason: report.reason, detail: report.detail });
  } catch {
    return notice(ctx, 400, "Report not sent", "Choose a reason and keep the details short.");
  }
  return notice(ctx, 200, "Thank you", "Your report was received.");
}

/** The public origin's pages. Returns undefined for a path that is not one of them. */
export function handleViewer(
  request: Request,
  url: URL,
  ctx: ServiceContext,
  client: string,
): Response | Promise<Response> | undefined {
  if (url.pathname === "/static/viewer.css") {
    if (request.method !== "GET") return undefined;
    return new Response(VIEWER_CSS, { headers: viewerHeaders(ctx, "text/css; charset=utf-8") });
  }
  const match = /^\/s\/([^/]+)(\/report)?$/.exec(url.pathname);
  if (match === null) return undefined;
  const id = match[1] ?? "";
  if (!isShareId(id)) return notice(ctx, 404, "Not found", "There is no Canvas at this address.");
  if (match[2] !== undefined) {
    return request.method === "POST" ? reportViaForm(request, ctx, id, client) : undefined;
  }
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  return viewShare(request, url, ctx, id, client);
}
