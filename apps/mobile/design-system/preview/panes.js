/* Panes: one or two independent navigation stacks inside the device frame.
   A compact window shows the selected pane; a wide window shows one surface in
   full or two side by side. Folding only changes what is visible. The other
   pane keeps its screens, scroll position, draft and attachments. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const phone = $(".phone");
const viewport = $("#viewport");
const tabbarEl = $("#tabbar");

viewport.innerHTML = `
  <div class="shell">
    <aside class="ipad-side" id="ipad-side"></aside>
    <div class="panes">
      <div class="pane" data-pane-id="0"></div>
      <div class="pane" data-pane-id="1"></div>
    </div>
    <aside class="ipad-inspector" id="ipad-inspector"></aside>
  </div>
  <div class="device-layer" id="device-layer"></div>`;

const panes = $$(".pane", viewport).map((el, id) => ({ id, el, stack: [], linked: false }));

/* order: which pane sits on the left. split: two panes are wanted when the
   window is wide. full: the person chose Full screen, so rows stop opening
   beside their list. A linked pane was opened from the list in the other one
   and closes on Back. */
const layout = { order: [0, 1], split: false, full: false, focus: 0 };

let activeTab = "home";
let beforeMode = localStorage.getItem("octant-mock-before") === "1";
let deviceRoute = null;
let sideHidden = false;

const TABS = [
  { key: "home", label: "Home", icon: "house" },
  { key: "bots", label: "Bots", icon: "bot" },
  { key: "threads", label: "Threads", icon: "message-square" },
  { key: "prs", label: "Pull requests", icon: "git-pull-request" },
  { key: "inbox", label: "Inbox", icon: "inbox" },
];
const TAB_KEYS = TABS.map((t) => t.key);
const CONVERSATION_KINDS = new Set(["thread", "bot", "pr"]);

function visibleTabs() {
  return beforeMode ? TABS.filter((t) => ["home", "threads", "inbox"].includes(t.key)) : TABS;
}

/* ---------- window shape ---------- */

const POSTURES = {
  duo: [
    ["folded", "Folded"],
    ["unfolded", "Unfolded"],
  ],
  androidfold: [
    ["single", "Single screen"],
    ["unfolded", "Unfolded"],
    ["spanned", "Spanned (dual screen)"],
  ],
};
let posture = localStorage.getItem("octant-mock-posture") || "folded";

const isAndroid = () => deviceMode === "android" || deviceMode === "androidfold";
const isSpanned = () => deviceMode === "androidfold" && posture === "spanned";
function isWide() {
  return (
    deviceMode === "ipad" ||
    isSpanned() ||
    (["duo", "androidfold"].includes(deviceMode) && posture === "unfolded")
  );
}

/* ---------- routes ---------- */

const DEVICE_PAGES = new Set(["lock", "homescreen", "android-notification"]);

function parseRoute(hash) {
  const h = (hash || "").replace(/^#\/?/, "");
  if (!h) return { name: "home", arg: null, route: "home" };
  const [name, arg] = h.split("/");
  return { name, arg, route: arg ? `${name}/${arg}` : name };
}
const isTab = (r) => TAB_KEYS.includes(parseRoute(r).name);
const isDevicePage = (r) => DEVICE_PAGES.has(parseRoute(r).name);
const isConversation = (r) => CONVERSATION_KINDS.has(parseRoute(r).name);

function routeTitle(r) {
  const { name, arg } = parseRoute(r);
  if (name === "thread") return threadById(arg).title;
  if (name === "bot") return (BOTS.find((b) => b.id === arg) || BOTS[1]).name;
  if (name === "pr") return `Pull request #${arg}`;
  if (name === "computer") return (COMPUTERS[arg] || COMPUTERS.studio).name;
  if (name === "list") return (COUNTS[arg] || COUNTS.needs).label;
  if (name === "pair") return "Pair a computer";
  if (name === "settings") return "Settings";
  return (TABS.find((t) => t.key === name) || TABS[0]).label;
}

/* ---------- pane lookup ---------- */

const topOf = (p) => p.stack[p.stack.length - 1];
const otherPane = (p) => panes[1 - p.id];
const focusedPane = () => panes[layout.focus];
const topScreen = () => topOf(focusedPane());
const isOpen = (p) => p.stack.length > 0;
const isSplit = () => isWide() && layout.split && panes.every(isOpen);
const paneOf = (el) => {
  const host = el && el.closest(".pane");
  return host ? panes[+host.dataset.paneId] : focusedPane();
};
/* the pane the bottom bar sits on and switches */
const barPane = () => (isSplit() ? panes[layout.order[0]] : focusedPane());
const allScreens = () => panes.flatMap((p) => p.stack);
const screenOf = (el) => {
  const node = el.closest(".screen");
  return allScreens().find((s) => s.el === node);
};

/* ---------- scroll position ---------- */

/* Text reflows when a pane changes width, so the place is kept as the first
   visible item and how far into it the person had read, not as pixels. */
const ANCHORS =
  ".transcript > *, .md > *, .trow, .nrow, .notif-row, .prrow, .comp-row, .set-row, .section-label, .tiles, .prbody > *, .filecard, .set-head";

function readPlace(s) {
  const sc = s.el.querySelector(":scope > .scroll");
  if (!sc || !sc.clientHeight) return;
  if (sc.scrollTop < 1) {
    s.place = { start: true };
    return;
  }
  const name = parseRoute(s.route).name;
  if (
    (name === "thread" || name === "bot") &&
    sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4
  ) {
    s.place = { end: true };
    return;
  }
  const top = sc.getBoundingClientRect().top;
  for (const el of sc.querySelectorAll(ANCHORS)) {
    if (el.matches(".md")) continue;
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= top + 1) continue;
    const into = top - r.top;
    s.place = { el, gap: into > 0 ? 0 : -into, read: into > 0 ? into / r.height : 0 };
    return;
  }
}

function restorePlace(s) {
  const sc = s.el.querySelector(":scope > .scroll");
  if (!sc || !sc.clientHeight || !s.place) return;
  if (s.place.start) {
    sc.scrollTop = 0;
    return;
  }
  if (s.place.end) {
    sc.scrollTop = sc.scrollHeight;
    return;
  }
  if (!s.place.el.isConnected) return;
  const r = s.place.el.getBoundingClientRect();
  const top = sc.getBoundingClientRect().top;
  sc.scrollTop += r.top - top - (s.place.gap - s.place.read * r.height);
}

/* Change the layout and leave every pane where the person was reading. */
function relayout(change) {
  allScreens().forEach(readPlace);
  const active = document.activeElement;
  const caret =
    active && active.matches && active.matches(".composer input")
      ? [active.selectionStart, active.selectionEnd]
      : null;
  change();
  layoutPanes();
  if (caret && active.isConnected && active !== document.activeElement) {
    active.focus({ preventScroll: true });
    active.setSelectionRange(...caret);
  }
  allScreens().forEach(restorePlace);
}

/* ---------- layout ---------- */

function layoutPanes() {
  const wide = isWide();
  const split = isSplit();
  const spanned = isSpanned();
  const bar = barPane();
  const listBeside =
    split && isTab(topOf(panes[layout.order[0]]).route) && panes[layout.order[1]].linked;
  const inspecting =
    deviceMode === "ipad" && ipadInspector && parseRoute(topScreen()?.route).name === "thread";
  const side = deviceMode === "ipad" && !sideHidden && !(inspecting && split);

  phone.classList.toggle("wide", wide);
  phone.classList.toggle("split", split);
  phone.classList.toggle("spanned", spanned);
  phone.classList.toggle("spanfull", spanned && !split);
  phone.classList.toggle("android", isAndroid());
  phone.classList.toggle("has-side", side);
  phone.classList.toggle("has-insp", inspecting);
  phone.classList.toggle("can-split", wide || panes.every(isOpen));
  phone.classList.toggle("on-device-page", !!deviceRoute);

  panes.forEach((p) => {
    const visible = split || p === focusedPane();
    const other = otherPane(p);
    p.el.hidden = !visible;
    p.el.inert = !visible;
    p.el.style.order = layout.order.indexOf(p.id);
    p.el.classList.toggle("focused", p === focusedPane());
    p.el.classList.toggle("has-bar", p === bar && !side);
    p.el.classList.toggle("listcol", listBeside && p === bar);
    p.el.classList.toggle(
      "no-back",
      p.stack.length <= 1 && !(isOpen(other) && (p.linked || !split)),
    );
    p.stack.forEach((s, i) => {
      const depth = p.stack.length - 1 - i;
      s.el.style.display = depth > 1 ? "none" : "";
      s.el.inert = depth > 0;
      s.el.classList.toggle("under", depth > 0);
    });
    const b = $$(".split-btn", p.el);
    b.forEach((x) =>
      x.setAttribute(
        "aria-label",
        split && p === focusedPane() ? "Split view, selected pane" : "Split view",
      ),
    );
  });

  $$(".pane-active", viewport).forEach((e) => e.classList.remove("pane-active"));
  if (split) {
    panes.forEach((p) => {
      const { arg } = parseRoute(topOf(p).route);
      if (!isConversation(topOf(p).route) || !arg) return;
      const row = otherPane(p).el.querySelector(
        `.rowwrap[data-tid="${arg}"], [data-bot="${arg}"], [data-pr="${arg}"]`,
      );
      if (row) row.classList.add("pane-active");
    });
  }
  renderSidebar(side);
  renderInspector(inspecting);
  renderTabbar(side);
  placeBar();
  updateSafeArea();
}

/* the bottom bar and the on-screen keyboard take the pane's own left and width */
function placeBar() {
  const frame = phone.getBoundingClientRect();
  const s = frame.width / phone.offsetWidth || 1;
  const r = barPane().el.getBoundingClientRect();
  const left = (r.left - frame.left) / s - 1;
  const width = r.width / s;
  const half = phone.classList.contains("spanfull") ? width / 2 - 8 : width;
  tabbarEl.style.setProperty("--bar-x", `${left}px`);
  tabbarEl.style.setProperty("--bar-w", `${half}px`);
}

function renderTabbar(side) {
  if (deviceRoute || side) {
    tabbarEl.classList.add("hidden");
    tabbarEl.innerHTML = "";
    return;
  }
  tabbarEl.classList.remove("hidden");
  const tabs = visibleTabs();
  const top = topOf(barPane());
  const current = top ? top.tab : activeTab;
  const key = tabs.some((t) => t.key === current)
    ? current
    : tabs.some((t) => t.key === activeTab)
      ? activeTab
      : tabs[0].key;
  const android = isAndroid();
  const buttons = tabs
    .map(
      (t) => `
    <button class="${android ? "anav" : "tabbtn"} ${t.key === key ? "active" : ""}" data-tab="${t.key}"
      aria-label="${t.label}" title="${t.label}" ${t.key === key ? 'aria-current="page"' : ""}>${I(t.icon, android ? "s22" : "")}</button>`,
    )
    .join("");
  const inConversation = top && isConversation(top.route);
  tabbarEl.innerHTML = android
    ? `<nav class="android-nav" aria-label="Places">${buttons}</nav>
       ${inConversation ? "" : `<button class="android-fab" data-new aria-label="New">${I("square-pen", "s22")}</button>`}`
    : `<nav class="capsule" aria-label="Places">${buttons}</nav>
       <button class="newbtn" data-new aria-label="New" title="New">${I("square-pen")}</button>`;
}

function renderSidebar(side) {
  const el = $("#ipad-side");
  el.hidden = !side;
  if (!side) {
    el.innerHTML = "";
    return;
  }
  const base = barPane().stack[0];
  const place = base ? parseRoute(base.route).name : "home";
  const pinned = beforeMode ? [] : BOTS;
  el.innerHTML = `
    <div class="ipad-brand"><img src="../../assets/icon.png" alt=""><span>Octant</span>
      <button class="ipad-compose" data-new aria-label="New">${I("square-pen", "s16")}</button>
    </div>
    <div class="ipad-sec">Places</div>
    ${visibleTabs()
      .map(
        (t) =>
          `<button class="ipad-place ${t.key === place ? "active" : ""}" data-tab="${t.key}">${I(t.icon, "s17")}<span>${t.label}</span></button>`,
      )
      .join("")}
    ${pinned.length ? `<div class="ipad-sec">Pinned bots</div>${pinned.map((b) => `<button class="ipad-bot" data-side-open="bot/${b.id}">${botAvatarHTML(b, 26)}<span class="ib-name">${esc(b.name)}</span></button>`).join("")}` : ""}
    <div class="ipad-spacer"></div>
    <button class="ipad-place" data-side-push="settings">${I("settings", "s17")}<span>Settings</span></button>`;
}

function renderInspector(on) {
  const el = $("#ipad-inspector");
  el.hidden = !on;
  el.innerHTML = on
    ? `<div class="insp-head">Panes</div><div class="insp-body panes-host">${inspectorHTML()}</div>`
    : "";
}

/* ---------- hinge ---------- */

/* Sheets, menus, alerts and toasts stay on the display the person last
   touched, so nothing they can press straddles the hinge. */
let lastTouchX = null;
function updateSafeArea() {
  let l = 0,
    r = 0;
  if (isSpanned()) {
    const w = phone.clientWidth;
    const pane = focusedPane();
    const right =
      lastTouchX !== null
        ? lastTouchX > w / 2
        : isSplit()
          ? layout.order.indexOf(pane.id) === 1
          : isConversation(topOf(pane)?.route);
    if (right) l = w / 2 + 8;
    else r = w / 2 + 8;
  }
  phone.style.setProperty("--safe-l", `${l}px`);
  phone.style.setProperty("--safe-r", `${r}px`);
  phone.style.setProperty("--safe-w", `${phone.clientWidth - l - r}px`);
  return { left: l, right: phone.clientWidth - r };
}

/* ---------- on-screen keyboard ---------- */

let keyboardOn = false;
const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
$("#keyboard").innerHTML =
  KEY_ROWS.map(
    (row) =>
      `<div class="kb-row">${[...row].map((k) => `<span class="key">${k}</span>`).join("")}</div>`,
  ).join("") + `<div class="kb-row"><span class="key wide-key">space</span></div>`;

function syncKeyboard() {
  const field = document.activeElement;
  const show = keyboardOn && !!field && !!field.matches && field.matches(".pane .composer input");
  const pane = show ? paneOf(field) : null;
  if (
    phone.classList.contains("kb-open") === show &&
    (!pane || pane.el.classList.contains("kb-target"))
  )
    return;
  if (show) lastTouchX = field.getBoundingClientRect().left - phone.getBoundingClientRect().left;
  relayout(() => {
    phone.classList.toggle("kb-open", show);
    panes.forEach((p) => p.el.classList.toggle("kb-target", p === pane));
  });
}

/* ---------- navigation ---------- */

function syncHash() {
  const r = deviceRoute || topScreen()?.route;
  if (r && parseRoute(location.hash).route !== r) history.replaceState(history.state, "", "#/" + r);
}

/* The browser's Back works as the system Back. Each entry remembers the route
   of the one below it, so an in-app Back to that route can step back onto it
   instead of rewriting this entry into a duplicate the browser's Back would
   then have to pass through twice. */
function recordHash(r) {
  const prev = parseRoute(location.hash).route;
  if (prev !== r) history.pushState({ prev }, "", "#/" + r);
}

function focusPane(p) {
  if (layout.focus === p.id) return;
  relayout(() => {
    layout.focus = p.id;
  });
  syncHash();
}

function pushScreen(p, route, { instant = false } = {}) {
  const el = buildScreen(route);
  const prev = topOf(p);
  const animate = !instant && !!prev;
  if (animate) el.classList.add("enter-right");
  p.el.appendChild(el);
  const entry = { route, el, tab: isTab(route) ? route : prev ? prev.tab : activeTab };
  p.stack.push(entry);
  if (isTab(route)) activeTab = route;
  decorateScreen(entry);
  relayout(() => {});
  if (animate) {
    void el.offsetWidth;
    el.classList.remove("enter-right");
  }
  const { name, arg } = parseRoute(route);
  if (name === "thread" || name === "bot") {
    const sc = el.querySelector(".scroll");
    sc.scrollTop = sc.scrollHeight;
  }
  if (name === "thread") markRead(threadById(arg));
}

function clearPane(p) {
  p.stack.forEach((s) => {
    s.observer?.disconnect();
    s.el.remove();
  });
  p.stack = [];
  p.linked = false;
}

function popTo(p, index) {
  const leaving = p.stack.splice(index + 1);
  leaving.forEach((s) => {
    s.observer?.disconnect();
    s.el.inert = true;
    s.el.classList.add("leaving-right");
    void s.el.offsetWidth;
    s.el.classList.add("out");
    setTimeout(() => s.el.remove(), 280);
  });
  relayout(() => {});
}

/* a pane shown on its own always has a place to go back to */
function ensureRoot(p) {
  if (!isOpen(p) || isTab(p.stack[0].route) || isOpen(otherPane(p))) return;
  const root = visibleTabs().some((t) => t.key === activeTab) ? activeTab : "home";
  const entry = { route: root, el: buildScreen(root), tab: root };
  p.el.prepend(entry.el);
  p.stack.unshift(entry);
  p.stack.forEach((s) => {
    s.tab = root;
  });
  decorateScreen(entry);
}

/* Show a route in a pane: a place resets the pane, anything else is pushed. */
function openIn(p, route, opts = {}) {
  layout.focus = p.id;
  const at = p.stack.findIndex((s) => s.route === route);
  if (at >= 0) {
    if (at === p.stack.length - 1) layoutPanes();
    else popTo(p, at);
  } else if (isTab(route)) {
    clearPane(p);
    pushScreen(p, route, { instant: true });
  } else {
    // the same conversation already on screen: select it instead of opening it twice
    const other = otherPane(p);
    if (isSplit() && isConversation(route) && topOf(other).route === route) {
      layout.focus = other.id;
      layoutPanes();
    } else {
      if (!isOpen(p) && !opts.bare) pushScreen(p, "home", { instant: true });
      pushScreen(p, route, opts);
    }
  }
  syncHash();
}

/* Put a route in the other pane and show both. keep adds to what that pane
   already shows instead of replacing it. */
function openBeside(p, route, { linked = false, keep = false } = {}) {
  const other = otherPane(p);
  allScreens().forEach(readPlace);
  if (!isSplit()) layout.order = [p.id, other.id];
  if (layout.full) sideHidden = false;
  layout.split = true;
  layout.full = false;
  if (!keep) {
    clearPane(other);
    other.linked = linked;
  }
  openIn(other, route, { instant: !isOpen(other), bare: true });
  allScreens().forEach(restorePlace);
}

/* A row opens beside its list in a wide window. It stays in the same pane when
   the window is compact, when the person chose Full screen, and when they put
   something else beside the list themselves. */
const isList = (r) => isTab(r) || parseRoute(r).name === "list";
function openFrom(p, route) {
  const beside =
    isWide() &&
    !layout.full &&
    !p.linked &&
    isConversation(route) &&
    isList(topOf(p).route) &&
    (!isSplit() || otherPane(p).linked);
  if (beside) openBeside(p, route, { linked: true });
  else openIn(p, route);
}

function openRow(route, from) {
  recordHash(route);
  openFrom(paneOf(from), route);
}

/* A Home count is followed up beside Home, so Home stays in view. */
function openCount(route, from) {
  const p = paneOf(from);
  const other = otherPane(p);
  recordHash(route);
  if (!isWide() || layout.full || p.linked) {
    openIn(p, route);
    return;
  }
  const own = isSplit() && !other.linked;
  openBeside(p, route, { linked: !own, keep: own });
}

/* A pinned bot in the sidebar opens like a row in the list beside it. */
function openSide(route) {
  openFrom(barPane(), route);
}

function openPlace(tab) {
  let p = barPane();
  if (p.linked && !isSplit() && isOpen(otherPane(p))) {
    closePane(p);
    p = focusedPane();
  }
  openIn(p, tab);
}

function go(hash) {
  const r = parseRoute(hash).route;
  recordHash(r);
  if (isDevicePage(r)) {
    showDevicePage(r);
    return;
  }
  hideDevicePage();
  openFrom(focusedPane(), r);
}

function goBack(p = focusedPane()) {
  const below = history.state?.prev;
  layout.focus = p.id;
  const other = otherPane(p);
  if (p.stack.length > 1) popTo(p, p.stack.length - 2);
  else if (isOpen(other) && p.linked) closePane(p);
  else if (isOpen(other))
    relayout(() => {
      layout.focus = other.id;
    });
  if (below !== undefined && below === (deviceRoute || topScreen()?.route)) history.back();
  else syncHash();
}

function closePane(p) {
  const other = otherPane(p);
  if (!isOpen(other)) return;
  relayout(() => {
    clearPane(p);
    layout.split = false;
    layout.focus = other.id;
    other.linked = false;
    ensureRoot(other);
  });
  syncHash();
}

function fullScreen(p) {
  relayout(() => {
    layout.split = false;
    layout.full = true;
    layout.focus = p.id;
    sideHidden = true;
  });
  syncHash();
}

function showBoth() {
  relayout(() => {
    layout.split = true;
    layout.full = false;
  });
}

function swapPanes() {
  relayout(() => {
    layout.order.reverse();
  });
}

/* Opening out with a list and what it led to: show them side by side. */
function adaptOnUnfold() {
  const p = focusedPane();
  const other = otherPane(p);
  if (!isWide() || layout.full || p.linked || p.stack.length < 2) return;
  if (!isTab(p.stack[0].route) || !isConversation(topOf(p).route)) return;
  // a pane that is already open keeps its own stack; only an empty one takes
  // what the list led to
  if (isOpen(other)) return;
  clearPane(other);
  other.stack = p.stack.splice(1);
  other.stack.forEach((s) => other.el.appendChild(s.el));
  other.linked = true;
  layout.order = [p.id, other.id];
  layout.split = true;
  layout.focus = other.id;
}

function setPosture(next) {
  relayout(() => {
    posture = next;
    localStorage.setItem("octant-mock-posture", next);
    phone.dataset.posture = next;
    lastTouchX = null;
    adaptOnUnfold();
  });
  syncDeviceUI();
  syncHash();
}

function setDeviceMode(mode) {
  relayout(() => {
    deviceMode = mode;
    localStorage.setItem("octant-mock-device", mode);
    if (POSTURES[mode] && !POSTURES[mode].some(([k]) => k === posture))
      posture = POSTURES[mode][0][0];
    phone.dataset.device = mode;
    phone.dataset.posture = POSTURES[mode] ? posture : "";
    lastTouchX = null;
    adaptOnUnfold();
  });
  syncDeviceUI();
  syncHash();
}

/* ---------- device pages (Lock Screen, Home Screen, notification) ---------- */

function showDevicePage(r) {
  deviceRoute = r;
  $("#device-layer").replaceChildren(buildScreen(r));
  layoutPanes();
}
function hideDevicePage() {
  if (!deviceRoute) return;
  deviceRoute = null;
  $("#device-layer").replaceChildren();
  layoutPanes();
}

function route() {
  const r = parseRoute(location.hash).route;
  if (isDevicePage(r)) {
    showDevicePage(r);
    return;
  }
  hideDevicePage();
  const p = focusedPane();
  const other = otherPane(p);
  // the system Back out of a linked pane closes it, rather than showing the
  // list it came from a second time
  if (p.linked && isOpen(other) && !p.stack.some((s) => s.route === r)) {
    if (topOf(other).route === r) {
      closePane(p);
      return;
    }
    if (isTab(r)) {
      closePane(p);
      openIn(other, r);
      return;
    }
  }
  openFrom(p, r);
}
window.addEventListener("hashchange", route);

/* ---------- every in-app screen gets the split control ---------- */

function decorateScreen(s) {
  const el = s.el;
  const scroll = el.querySelector(":scope > .scroll");
  if (scroll) {
    const inner = document.createElement("div");
    inner.className = "scroll-in";
    inner.append(...scroll.childNodes);
    scroll.appendChild(inner);
  }
  const btn = document.createElement("button");
  btn.className = "navbtn split-btn";
  btn.dataset.menu = "split";
  btn.setAttribute("aria-haspopup", "menu");
  btn.innerHTML = I("columns-2", "s18");
  const navbar = el.querySelector(".navbar");
  if (navbar) navbar.appendChild(btn);
  else {
    const head = el.querySelector(".home-head, .large-head");
    let actions = head.querySelector(".head-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "head-actions";
      head.appendChild(actions);
    }
    actions.appendChild(btn);
  }
  if (el.classList.contains("dock")) {
    const side = document.createElement("div");
    side.className = "span-side";
    side.innerHTML = spanSideHTML(s.route);
    el.appendChild(side);
    const docked = el.querySelector(".composer, .praction");
    s.observer = new ResizeObserver(() => {
      if (!docked.offsetHeight) return;
      const sc = el.querySelector(".scroll");
      const atEnd = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4;
      el.style.setProperty("--dock-h", `${docked.offsetHeight}px`);
      if (atEnd && parseRoute(s.route).name !== "pr") sc.scrollTop = sc.scrollHeight;
    });
    el.style.setProperty("--dock-h", `${docked.offsetHeight}px`);
    s.observer.observe(docked);
  }
  wireAndroidAppbar(s);
  restoreDraft(s);
}

/* On a dual screen a conversation keeps its text and controls on one display;
   the other shows what it is about. */
function spanSideHTML(r) {
  const { name, arg } = parseRoute(r);
  if (name === "thread") return `<div class="panes-host">${inspectorHTML()}</div>`;
  if (name === "pr") {
    const p = PR2864;
    return `<div class="side-title">${esc(p.title)}</div><div class="side-sub mono">${esc(p.branch)} → ${esc(p.base)}</div>
      ${p.files.map((f) => `<div class="side-file"><span class="mono">${esc(f.path)}</span><span><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></div>`).join("")}`;
  }
  const b = BOTS.find((x) => x.id === arg) || BOTS[1];
  return `<div class="side-title">${esc(b.name)}</div><div class="side-sub">${esc(b.role)}</div>`;
}

/* ---------- Android top app bar on place screens ---------- */

function wireAndroidAppbar(s) {
  const head = s.el.querySelector(".large-head, .home-head");
  const sc = s.el.querySelector(":scope > .scroll");
  if (!head || !sc) return;
  const bar = document.createElement("div");
  bar.className = "android-appbar";
  bar.textContent = routeTitle(s.route);
  s.el.prepend(bar);
  sc.addEventListener("scroll", () => s.el.classList.toggle("abar-on", sc.scrollTop > 64), {
    passive: true,
  });
}

/* ---------- split control menu ---------- */

function splitMenu(anchor) {
  const p = paneOf(anchor);
  const other = otherPane(p);
  const places = (act) => [
    ...visibleTabs().map((t) => ({ label: t.label, icon: t.icon, run: () => act(t.key) })),
    { label: "Settings", icon: "settings", run: () => act("settings") },
  ];
  if (!isWide()) {
    return [
      {
        label: `Switch to ${routeTitle(topOf(other).route)}`,
        icon: "columns-2",
        run: () => {
          relayout(() => {
            layout.focus = other.id;
          });
          syncHash();
        },
      },
      { label: `Close ${routeTitle(topOf(other).route)}`, icon: "x", run: () => closePane(other) },
    ];
  }
  const sidebar =
    deviceMode === "ipad"
      ? [
          {
            label: sideHidden ? "Show sidebar" : "Hide sidebar",
            icon: "panel-right",
            run: () =>
              relayout(() => {
                sideHidden = !sideHidden;
              }),
          },
        ]
      : [];
  if (isSplit()) {
    return [
      { label: "Full screen", icon: "square", run: () => fullScreen(p) },
      { label: "Swap sides", icon: "arrow-up-down", run: swapPanes },
      { label: "Close this pane", icon: "x", run: () => closePane(p) },
      ...sidebar,
      { head: "Show in this pane" },
      ...places((r) => {
        p.linked = false;
        openIn(p, r);
      }),
    ];
  }
  return [
    ...(isOpen(other)
      ? [
          {
            label: `Split with ${routeTitle(topOf(other).route)}`,
            icon: "columns-2",
            run: showBoth,
          },
        ]
      : []),
    ...sidebar,
    { head: "Open beside" },
    ...places((r) => openBeside(p, r)).filter((i) => i.label !== routeTitle(topOf(p).route)),
  ];
}
