// The page a visitor opens: one small page, script and stylesheet, the same for
// every link, served by the hub's public entrance and never part of the web
// app. It holds no thread content; it reads the link's secret from the URL
// fragment, which a browser never sends, makes a key that cannot leave the
// browser, signs every request with it, and writes what the spoke sends as
// text, so nothing in a thread can run here.

import { createHash } from "node:crypto";
import type { HubVisitorViewer } from "./hubVisitorService";

const SCRIPT = String.raw`
"use strict";
(() => {
  const main = document.getElementById("thread");
  const status = document.getElementById("status");
  const title = document.getElementById("title");
  const form = document.getElementById("comment");
  const linkId = location.pathname.split("/")[2] || "";
  const secret = new URLSearchParams(location.hash.slice(1)).get("k");
  const say = (text) => { status.textContent = text; };
  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const store = () => new Promise((resolve, reject) => {
    const open = indexedDB.open("octant-visitor", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const remember = async (key, value) => {
    const db = await store();
    await new Promise((resolve) => {
      const put = db.transaction("keys", "readwrite").objectStore("keys").put(value, key);
      put.onsuccess = resolve;
      put.onerror = resolve;
    });
  };
  const recall = async (key) => {
    const db = await store();
    return new Promise((resolve) => {
      const request = db.transaction("keys").objectStore("keys").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  };
  // The spoke binds the first key that opens the link, so the key this page
  // signs with must be the one the browser keeps. A fresh pair is made first,
  // then one read-write transaction takes the stored pair or stores the fresh
  // one: two tabs opening the link at once settle on one key, and a key that
  // could not be stored is never used.
  const held = async () => {
    const db = await store();
    // The private key cannot be exported: the link stays with this browser.
    const fresh = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      const keys = tx.objectStore("keys");
      let chosen = fresh;
      const read = keys.get(linkId);
      read.onsuccess = () => {
        if (read.result !== undefined) chosen = read.result;
        else keys.put(fresh, linkId);
      };
      tx.oncomplete = () => resolve(chosen);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };

  let keys;
  let publicKey;
  const signed = async (method, path) => {
    keys ??= await held();
    publicKey ??= b64(await crypto.subtle.exportKey("spki", keys.publicKey));
    const timestamp = String(Date.now());
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    const payload = "octant/visitor-proof/v1|" + method + "|" + path + "|" + timestamp + "|" + nonce;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      new TextEncoder().encode(payload));
    return {
      "octant-visitor-key": publicKey,
      "octant-visitor-proof": timestamp + "." + nonce + "." + b64(signature),
    };
  };

  const STATES = { working: "Working", idle: "Waiting for the owner", "owner-deciding": "The owner is deciding" };
  const render = (view) => {
    title.textContent = view.title;
    document.title = view.title;
    say(STATES[view.state] || "");
    main.replaceChildren(...view.messages.map((message) => {
      const item = document.createElement("article");
      item.className = "message " + message.role;
      const who = document.createElement("p");
      who.className = "who";
      who.textContent = message.role === "agent" ? "Agent" : message.role === "visitor" ? "Visitor" : "Owner";
      const text = document.createElement("p");
      text.className = "text";
      text.textContent = message.text;
      item.append(who, text);
      return item;
    }));
  };

  // Only these answers end the link; anything else (a busy hub, a spoke
  // waking up, a rate limit) is retried.
  const ENDS = {
    410: "This link has ended.",
    403: "This link is open in another browser.",
    404: "This link does not exist.",
    401: "This link could not be checked. Make sure this device's clock is set correctly, then reload.",
    // A member's entrance carries opens and comments but not the live thread.
    501: "This address cannot show the live thread. Ask the owner for their hub's address.",
  };
  const ended = async (response) => {
    if (response.status === 403) {
      const reason = await response.json().then((body) => body.error, () => undefined);
      if (reason === "not-bound") return "Open this link from the full address you were sent.";
    }
    return ENDS[response.status];
  };
  const follow = async () => {
    const path = "/v/" + linkId + "/stream";
    const response = await fetch(path, { headers: await signed("GET", path), cache: "no-store" });
    if (!response.ok || response.body === null) return ended(response);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) return undefined;
      buffer += next.value;
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (event.startsWith("event: end")) return "This link has ended.";
        const data = event.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) render(JSON.parse(data.slice(6)));
      }
    }
  };

  // The first open waits out a busy hub or a spoke still waking up the same
  // way the stream does, and hands back the answer that settled it.
  const open = async () => {
    const path = "/v/" + linkId + "/open";
    let wait = 3000;
    for (;;) {
      const response = await fetch(path, {
        method: "POST",
        headers: { ...(await signed("POST", path)), "content-type": "application/json" },
        body: JSON.stringify({ secret }),
      }).catch(() => undefined);
      if (response !== undefined) {
        const final = response.ok ? undefined : await ended(response);
        if (response.ok || final !== undefined) return { response, final };
      }
      say("This link could not be opened yet. Trying again…");
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 60000);
    }
  };

  const run = async () => {
    if (secret !== null) {
      const { response, final } = await open();
      // The secret leaves the address bar only once the link is opened, has
      // ended, or is held by another browser. After a 401 (a skewed clock) or
      // a 404 (a grant that has not reached the hub yet) it stays, so a reload
      // can still open the link; a member's address that cannot show the
      // thread keeps it too, so the visitor can carry the whole link to the
      // hub's address.
      if (response.ok || response.status === 410 || response.status === 403) {
        history.replaceState(null, "", location.pathname);
      }
      if (!response.ok) return say(final);
      const opened = await response.json();
      await remember("scope:" + linkId, opened.scope);
    }
    if ((await recall("scope:" + linkId)) === "comment") form.hidden = false;
    let wait = 3000;
    for (;;) {
      const end = await follow().catch(() => undefined);
      if (end !== undefined) return say(end);
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 60000);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = form.querySelector("textarea");
    const text = field.value.trim();
    if (text === "") return;
    const path = "/v/" + linkId + "/comments";
    const response = await fetch(path, {
      method: "POST",
      headers: { ...(await signed("POST", path)), "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const note = form.querySelector(".note");
    note.textContent = response.ok
      ? "Sent to the owner. It reaches the thread only if they choose to send it."
      : response.status === 429
        ? "Too many comments at once. Wait a minute, then send it again."
        : "The owner is not taking comments right now.";
    if (response.ok) field.value = "";
  });

  run().catch(() => say("This browser cannot keep the key this link needs. Private browsing may be the cause."));
})();
`;

const STYLE = `
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1b1b1a; --muted: #6b6a66; --line: #e3e2de; --card: #ffffff; --accent: #2f5bd3; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #141413; --fg: #ecebe8; --muted: #9c9a94; --line: #2c2b29; --card: #1c1c1b; --accent: #8aa7ff; --on-accent: #141413; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
header, main, form { max-width: 760px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 28px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
h1 { font-size: 20px; margin: 0 0 4px; overflow-wrap: anywhere; }
#status { color: var(--muted); margin: 0; font-size: 13px; }
main { padding-top: 16px; padding-bottom: 24px; display: grid; gap: 12px; }
.message { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
.message.person { border-left: 3px solid var(--accent); }
.who { margin: 0 0 4px; font-size: 12px; color: var(--muted); font-weight: 600; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
form { padding-bottom: 32px; display: grid; gap: 8px; }
[hidden] { display: none !important; }
textarea { width: 100%; min-height: 84px; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
button { justify-self: start; font: inherit; font-weight: 600; color: var(--on-accent); background: var(--accent); border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
.note { margin: 0; color: var(--muted); font-size: 13px; }
footer { max-width: 760px; margin: 0 auto; padding: 0 16px 24px; color: var(--muted); font-size: 12px; }
`;

const nameFor = (body: string, extension: string) =>
  `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.${extension}`;

/** The viewer's page and its two assets, named by their content so a change never serves a stale copy. */
export function visitorViewer(): HubVisitorViewer {
  const script = nameFor(SCRIPT, "js");
  const style = nameFor(STYLE, "css");
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Shared thread</title>
<link rel="stylesheet" href="/v/_/${style}">
<script src="/v/_/${script}" defer></script>
</head>
<body>
<header><h1 id="title">Shared thread</h1><p id="status" role="status">Opening…</p></header>
<main id="thread" aria-live="polite"></main>
<form id="comment" hidden>
<label for="comment-text">Comment for the owner</label>
<textarea id="comment-text" maxlength="4000"></textarea>
<button type="submit">Send to the owner</button>
<p class="note" role="status"></p>
</form>
<footer>Shared from Octant. You can read this thread; you cannot act on it.</footer>
</body>
</html>`;
  return {
    page,
    assets: new Map([
      [script, { type: "text/javascript; charset=utf-8", body: SCRIPT }],
      [style, { type: "text/css; charset=utf-8", body: STYLE }],
    ]),
  };
}
