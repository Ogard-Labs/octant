/* Octant mobile redesign — clickable phone mockup. Vanilla JS, hash routing. */

/* ============================== data ============================== */

const COMPUTERS = {
  studio: { name: "Studio Mac", status: "connected", sub: "Connected · Local network" },
  devbox: { name: "Devbox", status: "stale", sub: "Last seen 2h ago" },
};

const PROJECTS = ["octant", "octant-site"];

const MODES = {
  chat: { label: "Chat", cls: "mb-chat", icon: "message-square" },
  work: { label: "Work", cls: "mb-work", icon: "zap" },
  code: { label: "Code", cls: "mb-code", icon: "square-code" },
};

/* status is what the thread's own turn is doing: working, waiting (on the
   person, with ask saying for what), failed, or finished. unread, snoozed and
   settled are separate facts about it. Every count and list below reads these. */
const THREADS = [
  {
    id: "sync",
    title: "Speed up the sync worker",
    mode: "code",
    computer: "studio",
    project: "octant",
    status: "working",
    elapsed: "2m",
    pr: null,
  },
  {
    id: "pairing",
    title: "Fix flaky pairing test",
    mode: "code",
    computer: "studio",
    project: "octant",
    status: "waiting",
    ask: "approval",
    elapsed: "12m",
    pr: null,
  },
  {
    id: "botsplan",
    title: "Plan the Bots tab",
    mode: "work",
    computer: "studio",
    project: "octant",
    status: "waiting",
    ask: "question",
    elapsed: "22m",
    pr: "+4",
  },
  {
    id: "s2",
    title: "Triage crash reports from 0.1",
    mode: "chat",
    computer: "studio",
    project: "octant",
    status: "failed",
    elapsed: "26m",
    pr: null,
  },
  {
    id: "ipad",
    title: "Add iPad split view",
    mode: "code",
    computer: "studio",
    project: "octant",
    status: "working",
    elapsed: "44m",
    pr: "+2",
  },
  {
    id: "payload",
    title: "Review the push payload proposal",
    mode: "chat",
    computer: "studio",
    project: "octant",
    status: "finished",
    unread: true,
    elapsed: "1h",
    pr: "#2864",
  },
  {
    id: "s9",
    title: "Write release notes for 0.1",
    mode: "chat",
    computer: "studio",
    project: "octant",
    status: "finished",
    unread: true,
    elapsed: "1h",
    pr: null,
  },
  {
    id: "release",
    title: "Write release notes for 0.2",
    mode: "chat",
    computer: "devbox",
    project: "octant",
    status: "working",
    elapsed: "2h",
    pr: null,
  },
  {
    id: "s8",
    title: "Polish empty states",
    mode: "chat",
    computer: "studio",
    project: "octant",
    status: "finished",
    elapsed: "5h",
    pr: null,
  },
  {
    id: "tokens",
    title: "Migrate theme tokens to CSS variables",
    mode: "code",
    computer: "devbox",
    project: "octant",
    status: "finished",
    settled: true,
    elapsed: "5h",
    pr: "#2851",
  },
  {
    id: "s1",
    title: "Audit accessibility labels in settings",
    mode: "work",
    computer: "studio",
    project: "octant",
    status: "finished",
    settled: true,
    elapsed: "1d",
    pr: null,
  },
  {
    id: "s3",
    title: "Draft the 0.1 changelog",
    mode: "chat",
    computer: "studio",
    project: "octant-site",
    status: "finished",
    settled: true,
    elapsed: "2d",
    pr: null,
  },
  {
    id: "s4",
    title: "Port settings search to mobile",
    mode: "code",
    computer: "studio",
    project: "octant",
    status: "finished",
    settled: true,
    elapsed: "2d",
    pr: null,
  },
  {
    id: "s5",
    title: "Spike: offline queue replay",
    mode: "code",
    computer: "devbox",
    project: "octant",
    status: "finished",
    settled: true,
    elapsed: "3d",
    pr: null,
  },
  {
    id: "s6",
    title: "Review onboarding copy",
    mode: "work",
    computer: "studio",
    project: "octant",
    status: "finished",
    settled: true,
    elapsed: "4d",
    pr: null,
  },
  {
    id: "s7",
    title: "Fix dock resize jitter",
    mode: "code",
    computer: "studio",
    project: "octant",
    status: "finished",
    settled: true,
    elapsed: "4d",
    pr: "#2790",
  },
];

const isConnected = (t) => COMPUTERS[t.computer].status === "connected";

/* The panel's "Nothing waiting" state, for the empty lists. */
let emptyCounts = false;

/* One place decides what a thread counts as. Home's counts, their lists, the
   Threads sections, Inbox and the awareness previews all ask it, so a number
   and the rows behind it cannot disagree. A computer that has gone offline
   reports nothing, so its last-known turn is not counted as working. Work
   threads have no unread state, so they never count as To review. */
function sectionOf(t) {
  if (t.snoozed) return "snoozed";
  if (t.settled) return "settled";
  if (emptyCounts) return "idle";
  if (t.status === "waiting" || t.status === "failed") return "needs";
  if (t.status === "working" && isConnected(t)) return "working";
  if (t.status === "finished" && t.unread && t.mode !== "work") return "review";
  return "idle";
}
const threadsIn = (key) => THREADS.filter((t) => sectionOf(t) === key);

const COUNTS = {
  needs: {
    label: "Needs you",
    icon: "inbox",
    color: "var(--palette-blue)",
    empty: "Nothing needs you right now.",
  },
  working: {
    label: "Working",
    icon: "circle-play",
    color: "var(--palette-orange)",
    empty: "No thread is working.",
  },
  review: {
    label: "To review",
    icon: "eye",
    color: "var(--palette-purple)",
    empty: "No finished turns to review.",
  },
};

const SECTIONS = [
  { key: "needs", label: "Needs you" },
  { key: "working", label: "Working" },
  { key: "review", label: "To review" },
  { key: "idle", label: "Idle" },
  { key: "snoozed", label: "Snoozed" },
  { key: "settled", label: "Settled" },
];

const STATUS_META = {
  needs: { cls: "needs", icon: "help-circle", label: "Needs you" },
  working: { cls: "working", icon: "circle-play", label: "Working" },
  review: { cls: "review", icon: "eye", label: "To review" },
  idle: { cls: "settled", icon: "circle-dot", label: "Idle" },
  snoozed: { cls: "settled", icon: "moon", label: "Snoozed" },
  settled: { cls: "settled", icon: "check", label: "Settled" },
};

/* What the host answers when a thread cannot be settled or snoozed. */
function restRefusal(t, action) {
  if (!isConnected(t)) return `${compName(t.computer)} is offline`;
  if (t.status === "waiting") return "The agent is waiting on you. Answer it first.";
  if (t.status === "working" && action === "settle")
    return "A turn is running. Settle it when it finishes.";
  return null;
}

/* A host preference, so the phone shows it and does not change it. */
const SETTLES_WHEN_DONE = { studio: true, devbox: false };

const BOTS = [
  {
    id: "navigator",
    name: "Navigator",
    role: "What should I keep an eye on for you today?",
    lead: true,
    g1: "var(--palette-blue)",
    g2: "var(--palette-purple)",
    glyph: "star",
  },
  {
    id: "bugscout",
    name: "Bug Scout",
    role: "Which bugs should I hunt down next?",
    g1: "var(--palette-orange)",
    g2: "var(--palette-red)",
    glyph: "bug",
  },
  {
    id: "release",
    name: "Release Captain",
    role: "What should go into the next release?",
    g1: "var(--palette-green)",
    g2: "var(--palette-teal)",
    glyph: "rocket",
  },
];

const REPOS = [
  {
    name: "Ogard-Labs/octant",
    prs: [
      {
        n: 2864,
        title: "Add push payload signing to the sync worker",
        state: "open",
        branch: "feature/push-payload",
        base: "main",
        author: "henrik",
        time: "2h",
        meta: "In review",
      },
      {
        n: 2859,
        title: "Cache the thread list snapshot on mobile",
        state: "open",
        branch: "perf/thread-cache",
        base: "main",
        author: "henrik",
        time: "5h",
        meta: "Conflicts",
      },
      {
        n: 2855,
        title: "Fix pairing flake in the sync test suite",
        state: "draft",
        branch: "fix/pairing-flake",
        base: "main",
        author: "henrik",
        time: "1d",
        meta: "Draft",
      },
      {
        n: 2851,
        title: "Migrate theme tokens to CSS variables",
        state: "open",
        branch: "theme/css-tokens",
        base: "main",
        author: "henrik",
        time: "2d",
        meta: "ok",
      },
      {
        n: 2848,
        title: "Bump xterm and rework the terminal font stack",
        state: "open",
        branch: "deps/xterm",
        base: "main",
        author: "henrik",
        time: "3d",
        meta: "ok",
      },
    ],
  },
  {
    name: "Ogard-Labs/octant-site",
    prs: [
      {
        n: 132,
        title: "Rewrite the pricing page copy",
        state: "open",
        branch: "copy/pricing",
        base: "main",
        author: "henrik",
        time: "4h",
        meta: "In review",
      },
      {
        n: 128,
        title: "Add a case study for the Studio Mac setup",
        state: "merged",
        branch: "case-studies/studio-mac",
        base: "main",
        author: "henrik",
        time: "1d",
        meta: "ok",
      },
    ],
  },
];

const PR2864 = {
  n: 2864,
  title: "Add push payload signing to the sync worker",
  branch: "feature/push-payload",
  base: "main",
  add: 212,
  del: 48,
  description: [
    {
      t: "p",
      x: "The sync worker currently sends payloads unsigned, so a tampered queue entry is indistinguishable from a real one. This PR signs each payload with the device key before it leaves the worker.",
    },
    { t: "h", x: "What changed" },
    {
      t: "ul",
      x: [
        "Sign payloads with the device key before enqueue",
        "Verify signatures on the receiving side and reject mismatches",
        "Rotate keys when a computer goes stale",
      ],
    },
    { t: "h", x: "Still to do" },
    {
      t: "tasks",
      x: [
        { done: true, x: "Sign payloads with the device key before enqueue" },
        { done: true, x: "Verify signatures on the receiving side and reject mismatches" },
        { done: false, x: "Add a metric for rejected payloads" },
        { done: false, x: "Document the key rotation flow" },
      ],
    },
  ],
  checks: [
    { name: "lint", sub: "oxlint · 41 files", state: "pass", time: "38s" },
    { name: "typecheck", sub: "tsc --noEmit", state: "pass", time: "1m 12s" },
    { name: "test", sub: "vitest run", state: "pass", time: "3m 04s" },
    { name: "sync e2e", sub: "scenarios:prove", state: "pending", time: "queued" },
  ],
  files: [
    {
      path: "apps/server/src/sync/push.ts",
      add: 86,
      del: 12,
      open: true,
      diff: [
        ["ctx", " 1", 'import { createHash } from "node:crypto";'],
        ["ctx", " 2", 'import { signPayload } from "./sign.js";'],
        ["del", " 3", "-export async function pushPayload(entry: QueueEntry) {"],
        ["del", " 4", "-  await transport.send(entry.payload);"],
        ["add", " 3", "+export async function pushPayload(entry: QueueEntry, key: DeviceKey) {"],
        ["add", " 4", "+  const signature = await signPayload(entry.payload, key);"],
        ["add", " 5", "+  await transport.send({ ...entry.payload, signature });"],
        ["ctx", " 6", "}"],
        ["add", " 7", "+"],
        [
          "add",
          " 8",
          "+export async function verifyIncoming(raw: SignedPayload, key: DeviceKey) {",
        ],
        ["add", " 9", "+  if (!verify(raw.signature, raw.payload, key)) throw new BadSignature();"],
        ["add", "10", "+  return raw.payload;"],
        ["add", "11", "+}"],
      ],
    },
    { path: "packages/contracts/src/push.ts", add: 64, del: 20, open: false },
    { path: "apps/server/src/sync/verify.ts", add: 38, del: 9, open: false },
    { path: "docs/internals/09_connection-runtime.md", add: 24, del: 7, open: false },
  ],
  commits: [
    {
      hash: "a3f9c21",
      msg: "Sign sync payloads with the device key",
      author: "henrik",
      time: "2h",
    },
    {
      hash: "7be02d4",
      msg: "Verify incoming signatures and reject mismatches",
      author: "henrik",
      time: "4h",
    },
    {
      hash: "e81c6b9",
      msg: "Add signature field to the push contract",
      author: "henrik",
      time: "1d",
    },
  ],
  activity: [
    {
      who: "henrik",
      when: "12m",
      text: "Pushed the key rotation notes into the description. The e2e scenario is still queued on CI.",
    },
    {
      who: "Mara",
      when: "1h",
      text: "The verify path looks right. One nit: `BadSignature` should carry the payload hash so the log line is useful.",
    },
    {
      who: "henrik",
      when: "2h",
      text: "Addressed — `BadSignature` now includes `payloadHash`. Ready for another look.",
    },
  ],
};

/* awareness previews (Lock Screen, widgets, Island, Android notification) */
const PHASE_COLOR = {
  input: "var(--palette-blue)",
  approval: "var(--palette-yellow)",
  working: "var(--palette-orange)",
  done: "var(--success-text)",
  failed: "var(--danger-text)",
};
const aware = () =>
  [...threadsIn("needs"), ...threadsIn("working")].map((t) => {
    const [phase, status] =
      t.status === "failed"
        ? ["failed", "Failed"]
        : t.ask === "approval"
          ? ["approval", "Approval"]
          : t.ask === "question"
            ? ["input", "Question"]
            : ["working", "Working"];
    return { tid: t.id, phase, status };
  });
const awareRow = (a) => {
  const t = threadById(a.tid);
  const name = showNames ? t.title : `Thread on ${compName(t.computer)}`;
  return `<div class="aware-row">
    <div class="aware-main"><div class="a1">${esc(name)}</div><div class="a2">${esc(t.project)}</div></div>
    <div class="a3" style="color:${PHASE_COLOR[a.phase]}">${a.status}</div>
  </div>`;
};
const awareCounts = () => ({
  active: threadsIn("needs").length + threadsIn("working").length,
  needs: threadsIn("needs").length,
});

const MODE_OPTIONS = ["Plan", "Ask first", "Auto", "Full access"];
const MODEL_GROUPS = [
  { provider: "Claude", models: ["Opus", "Sonnet", "Haiku"] },
  { provider: "Codex", models: ["GPT-5.5", "GPT-5.5 mini"] },
];
const EFFORTS = ["Low", "Medium", "High"];
let modelState = { model: "Opus", effort: "High" };
let modeState = "Ask first";
let showNames = localStorage.getItem("octant-mock-names") === "1";
let deviceMode = localStorage.getItem("octant-mock-device") || "phone";
let panesState = { seg: 0, view: "root", file: null };
let ipadInspector = false;

const INBOX = {
  notifs: [
    {
      icon: "bell-dot",
      tint: "var(--warning-text)",
      title: "Approval needed · npm test",
      sub: "Fix flaky pairing test · Studio Mac",
      when: "4m",
      open: "thread/pairing",
    },
    {
      icon: "message-circle-question",
      tint: "var(--accent)",
      title: "Asks which scope the sweep should cover",
      sub: "Plan the Bots tab · Studio Mac",
      when: "22m",
      open: "thread/botsplan",
    },
    {
      icon: "circle-check",
      tint: "var(--success-text)",
      title: "Finished in 6m",
      sub: "Write release notes for 0.1 · Studio Mac",
      when: "1h",
      open: "thread/s9",
    },
    {
      icon: "git-pull-request",
      tint: "var(--palette-purple)",
      title: "Review requested",
      sub: "Review the push payload proposal · Studio Mac",
      when: "3h",
      open: "thread/payload",
    },
    {
      icon: "bell-off",
      tint: "var(--text-muted)",
      title: "No longer available",
      sub: "Audit accessibility labels · Devbox",
      when: "2d",
      unavail: true,
    },
  ],
};

/* ============================== helpers ============================== */

const threadById = (id) => THREADS.find((t) => t.id === id) || THREADS[0];
const compName = (id) => COMPUTERS[id].name;

function statusGlyph(t) {
  const m = STATUS_META[sectionOf(t)];
  if (sectionOf(t) === "working") return `<span class="pulse-dot" title="Working"></span>`;
  if (sectionOf(t) === "needs" && t.status === "failed")
    return `<span class="status-glyph failed" title="Failed">${I("circle-x", "s15")}</span>`;
  return `<span class="status-glyph ${m.cls}" title="${m.label}">${I(m.icon, "s15")}</span>`;
}

function modeBadge(mode) {
  const m = MODES[mode];
  return `<span class="mbadge ${m.cls}" title="${m.label}">${I(m.icon)}</span>`;
}

function threadRowHTML(t) {
  const pr = t.pr ? `<span class="prchip">${esc(t.pr)}</span>` : "";
  return `
  <div class="rowwrap" data-tid="${t.id}">
    <div class="rowactions">
      <button class="act-snooze" data-act="${t.snoozed ? "wake" : "snooze"}">${I("moon", "s16")}<span>${t.snoozed ? "Wake" : "Snooze"}</span></button>
      <button class="act-settle" data-act="${t.settled ? "unsettle" : "settle"}">${I(t.settled ? "history" : "check", "s16")}<span>${t.settled ? "Un-settle" : "Settle"}</span></button>
    </div>
    <div class="trow row" data-tid="${t.id}" role="button" tabindex="0" aria-label="${esc(t.title)}, ${STATUS_META[sectionOf(t)].label}">
      ${modeBadge(t.mode)}
      <div class="main">
        <div class="t1">${t.pinned ? `<span class="pinmark">${I("pin", "s12")}</span>` : ""}${esc(t.title)}</div>
        <div class="t2">${I("monitor")}${compName(t.computer)}<span>·</span>${esc(t.project)}</div>
      </div>
      <div class="trail">
        ${pr}${statusGlyph(t)}<span class="elapsed">${t.elapsed}</span>
      </div>
    </div>
  </div>`;
}

/* ============================== screens ============================== */

function tileHTML(key) {
  const c = COUNTS[key];
  const n = threadsIn(key).length;
  return `
  <button class="tile" style="--tile-c:${c.color}" data-count="${key}" aria-label="${c.label}, ${n} ${n === 1 ? "thread" : "threads"}">
    <span class="top">${I(c.icon, "s16")}<span>${c.label}</span></span>
    <span class="num">${n}</span>
  </button>`;
}

function homeScreen() {
  // the threads that need the person come first
  const recent = ["needs", "review", "working", "idle"].flatMap(threadsIn).slice(0, 6);
  return `
  <section class="screen" data-route="home">
    <div class="scroll">
      <div class="home-head">
        <div class="brand"><img src="../../assets/icon.png" alt=""><span class="word">Octant</span></div>
        <div class="head-actions">
          <button class="navbtn" data-dead="Search" aria-label="Search">${I("search", "s18")}</button>
          <button class="navbtn" data-push="settings" aria-label="Settings">${I("settings", "s18")}</button>
        </div>
      </div>
      <div class="tiles">${Object.keys(COUNTS).map(tileHTML).join("")}</div>
      <div class="section-label">Recent</div>
      <div class="screen-body">
        ${recent.map(threadRowHTML).join("")}
      </div>
      <div class="section-label">Computers</div>
      <div class="screen-body">
        ${Object.entries(COMPUTERS)
          .map(
            ([id, c]) => `
        <button class="comp-row" data-push="computer/${id}">
          <span class="comp-ic">${I("monitor")}</span>
          <span class="main">
            <span class="t1">${c.name}</span>
            <span class="t2"><span class="${c.status === "stale" ? "stale-dot" : "live-dot"}"></span>${c.sub}</span>
          </span>
        </button>`,
          )
          .join("")}
      </div>
    </div>
  </section>`;
}

/* what a Home count opens: exactly the threads it counted */
function countScreen(key) {
  const c = COUNTS[key] || COUNTS.needs;
  const k = COUNTS[key] ? key : "needs";
  const rows = threadsIn(k);
  return `
  <section class="screen" data-route="list/${k}">
    <div class="navbar">
      <button class="navbtn" data-back aria-label="Back">${I("chevron-left", "s20")}</button>
      <div class="navtitle"><div class="t">${c.label}</div><div class="s">${rows.length} ${rows.length === 1 ? "thread" : "threads"}</div></div>
    </div>
    <div class="scroll">
      <div class="screen-body">${rows.map(threadRowHTML).join("")}</div>
      ${rows.length ? "" : `<div class="empty-note">${c.empty}</div>`}
    </div>
  </section>`;
}

const threadFilter = { computers: null, projects: null, modes: null };
const FILTER_ALL = { computers: "All computers", projects: "All projects", modes: "All modes" };
const passesFilter = (t) =>
  (!threadFilter.computers || compName(t.computer) === threadFilter.computers) &&
  (!threadFilter.projects || t.project === threadFilter.projects) &&
  (!threadFilter.modes || MODES[t.mode].label === threadFilter.modes);
const collapsedSections = new Set(["snoozed", "settled"]);

/* Finished work is settled by the person, or by a computer that does it when
   a thread is done. Neither is true everywhere, so the shelf says which. */
function settledNote() {
  const on = Object.keys(COMPUTERS)
    .filter((id) => SETTLES_WHEN_DONE[id])
    .map(compName);
  const off = Object.keys(COMPUTERS)
    .filter((id) => !SETTLES_WHEN_DONE[id])
    .map(compName);
  const parts = [];
  if (on.length) parts.push(`${on.join(" and ")} settles threads when they're done.`);
  if (off.length)
    parts.push(`On ${off.join(" and ")}, a thread stays in the list until you settle it.`);
  return parts.join(" ");
}

function threadsScreen() {
  const sections = SECTIONS.map((s) => {
    const rows = threadsIn(s.key).filter(passesFilter);
    if (!rows.length && s.key !== "settled") return "";
    const collapsed = collapsedSections.has(s.key);
    return `
    <div class="section${collapsed ? " collapsed" : ""}" data-sec="${s.key}">
      <button class="sechead${collapsed ? " collapsed" : ""}" data-sec="${s.key}" aria-expanded="${!collapsed}">
        <span>${s.label}</span><span class="n">(${rows.length})</span>
        <span class="chev ${collapsed ? "" : "open"}">${I("chevron-down", "s14")}</span>
      </button>
      <div class="rows screen-body">${rows.map(threadRowHTML).join("")}${s.key === "settled" ? `<div class="shelf-note">${settledNote()}</div>` : ""}</div>
    </div>`;
  }).join("");
  const chip = (key) =>
    `<button class="chip${threadFilter[key] ? " on" : ""}" data-menu="${key}">${threadFilter[key] || FILTER_ALL[key]} ${I("chevron-down", "s14")}</button>`;
  return `
  <section class="screen" data-route="threads">
    <div class="scroll">
      <div class="large-head">
        <div class="large-title">Threads</div>
        <div class="head-actions">
          <button class="navbtn" data-dead="Search threads" aria-label="Search">${I("search", "s18")}</button>
        </div>
      </div>
      <div class="chips">
        ${chip("computers")}${chip("projects")}${chip("modes")}
        <button class="chip" data-menu="arrange" aria-label="Arrange">${I("sliders-horizontal", "s14")}</button>
      </div>
      ${sections}
    </div>
  </section>`;
}

let inboxFilter = "all";
const INBOX_FILTERS = [
  ["all", "All"],
  ["urgent", "Urgent"],
  ["decide", "Decide"],
  ["stuck", "Stuck"],
  ["finished", "Finished"],
];
function inboxKind(t) {
  if (sectionOf(t) === "review") return "finished";
  return t.status === "failed" ? "stuck" : t.ask === "approval" ? "urgent" : "decide";
}
const INBOX_KIND = {
  urgent: {
    icon: "shield-check",
    tint: "var(--warning-text)",
    title: "Approval needed · npm test",
  },
  decide: {
    icon: "message-circle-question",
    tint: "var(--accent)",
    title: "Question · Which scope should the sweep cover?",
  },
  stuck: {
    icon: "circle-x",
    tint: "var(--danger-text)",
    title: "Failed · The provider stopped responding",
  },
  finished: {
    icon: "circle-check",
    tint: "var(--success-text)",
    title: "Finished · Ready to read",
  },
};
function inboxRowHTML(t) {
  const n = INBOX_KIND[inboxKind(t)];
  return `
    ${
      // A row with Allow and Deny holds buttons, so it is not one itself: its
      // own label opens the thread, and each action is its own control.
      t.ask === "approval"
        ? `<div class="nrow" data-kind="${inboxKind(t)}" data-open="thread/${t.id}">`
        : `<div class="nrow" data-kind="${inboxKind(t)}" data-open="thread/${t.id}" role="button" tabindex="0" aria-label="${esc(n.title)}: ${esc(t.title)}">`
    }
      <div class="kindic" style="background:color-mix(in srgb, ${n.tint} 16%, transparent);color:${n.tint}">${I(n.icon)}</div>
      <div class="main">
        <div class="k1">${esc(n.title)}</div>
        ${
          t.ask === "approval"
            ? `<div class="k2" data-open="thread/${t.id}" role="button" tabindex="0" aria-label="Open ${esc(t.title)}">${esc(t.title)}</div>`
            : `<div class="k2">${esc(t.title)}</div>`
        }
        <div class="k3">${compName(t.computer)} · ${esc(t.project)}</div>
        ${
          t.ask === "approval"
            ? `<div class="actions">
          <button class="mini-btn allow" data-inbox="allow" data-tid="${t.id}">Allow</button>
          <button class="mini-btn deny" data-inbox="deny" data-tid="${t.id}">Deny</button>
        </div>`
            : ""
        }
      </div>
    </div>`;
}

function inboxScreen() {
  const all = [...threadsIn("needs"), ...threadsIn("review")];
  const shown = all.filter((t) => inboxFilter === "all" || inboxKind(t) === inboxFilter);
  const card = (rows, empty) =>
    `<div class="needs-card">${rows.map(inboxRowHTML).join("") || `<div class="empty-note">${empty}</div>`}</div>`;
  const needsRows = shown.filter((t) => sectionOf(t) === "needs");
  const reviewRows = shown.filter((t) => sectionOf(t) === "review");
  const waiting = threadsIn("needs").length;
  const notifs = INBOX.notifs
    .map(
      (n) => `
    <div class="notif-row${n.unavail ? " unavail" : ""}"${n.open ? ` data-open="${n.open}" role="button" tabindex="0" aria-label="${esc(n.title)}: ${esc(n.sub)}"` : ""}>
      <div class="kindic" style="background:color-mix(in srgb, ${n.tint} 14%, transparent);color:${n.tint}">${I(n.icon)}</div>
      <div class="main">
        <div class="n1">${esc(n.title)}</div>
        <div class="n2">${esc(n.sub)}</div>
      </div>
      <div class="when">${n.when}</div>
    </div>`,
    )
    .join("");
  return `
  <section class="screen" data-route="inbox">
    <div class="scroll">
      <div class="large-head">
        <div>
          <div class="large-title">Inbox</div>
          <div class="inbox-sub">${waiting ? `${waiting} ${waiting === 1 ? "thread needs" : "threads need"} you.` : COUNTS.needs.empty}</div>
        </div>
      </div>
      <div class="chips">
        ${INBOX_FILTERS.map(([key, label]) => `<button class="chip${key === inboxFilter ? " on" : ""}" data-ick="${key}">${label}<span class="cn">${all.filter((t) => key === "all" || inboxKind(t) === key).length}</span></button>`).join("")}
      </div>
      ${inboxFilter === "finished" ? "" : `<div class="section-label">Needs you</div>${card(needsRows, "Nothing here right now.")}`}
      ${["all", "finished"].includes(inboxFilter) ? `<div class="section-label">To review</div>${card(reviewRows, COUNTS.review.empty)}` : ""}
      <div class="section-label">Recent notifications</div>
      <div class="screen-body">${notifs}</div>
    </div>
  </section>`;
}

function prsScreen() {
  const groups = REPOS.map(
    (r) => `
    <div class="repohead">${I("folder-git-2")}<span>${r.name}</span><span class="n">(${r.prs.length})</span>
      <button data-menu="prrepo" aria-label="Repository options">${I("more-horizontal", "s16")}</button>
    </div>
    <div class="screen-body">
      ${r.prs
        .map((p) => {
          const glyph =
            p.state === "merged"
              ? "git-merge"
              : p.state === "draft"
                ? "git-pull-request"
                : "git-pull-request-arrow";
          const gcls = p.state === "merged" ? "merged" : p.state === "draft" ? "draft" : "open";
          const trail =
            p.meta === "ok"
              ? `<span class="trail-ok">${I("circle-check")}</span>`
              : p.meta === "Draft"
                ? `<span class="pill" style="color:var(--text-muted);background:var(--control)">Draft</span>`
                : `<span class="pill ${p.meta === "Conflicts" ? "conflict" : "warn"}">${p.meta === "Conflicts" ? "Conflicts" : "In review"}</span>`;
          const repoShort = r.name.split("/")[1];
          const clickable = p.n === 2864 ? `data-pr="2864"` : `data-dead="PR #${p.n}"`;
          return `
        <div class="prrow row" ${clickable} role="button" tabindex="0" aria-label="${esc(p.title)}, #${p.n}" style="cursor:pointer">
          <div class="glyph ${gcls}">${I(glyph)}</div>
          <div class="main">
            <div class="p1">${esc(p.title)}</div>
            <div class="p2">${repoShort} · henrik · ${p.time} · #${p.n}</div>
          </div>
          <div class="trail">${trail}</div>
        </div>`;
        })
        .join("")}
    </div>`,
  ).join("");
  return `
  <section class="screen" data-route="prs">
    <div class="scroll">
      <div class="large-head">
        <div class="large-title">Pull requests</div>
        <div class="head-actions">
          <button class="navbtn" data-dead="Search pull requests" aria-label="Search">${I("search", "s18")}</button>
        </div>
      </div>
      <div class="chips">
        <button class="chip" data-menu="prcomputers">All computers ${I("chevron-down", "s14")}</button>
        <button class="chip" data-menu="prrepos">All repositories ${I("chevron-down", "s14")}</button>
        <button class="chip" data-needs-review>Needs my review</button>
        <button class="chip" data-menu="prsort" aria-label="Sort">${I("arrow-up-down", "s14")}</button>
      </div>
      ${groups}
    </div>
  </section>`;
}

function botsScreen() {
  const rows = BOTS.map(
    (b) => `
    <div class="row trow botrow" data-bot="${b.id}" role="button" tabindex="0" aria-label="${esc(b.name)}, ${esc(b.role)}" style="cursor:pointer">
      <div class="bot-avatar" style="width:40px;height:40px;background:linear-gradient(135deg,${b.g1},${b.g2})">${I(b.glyph)}</div>
      <div class="main">
        <div class="t1">${esc(b.name)}${b.lead ? `<span class="leadtag">Lead</span>` : ""}</div>
        <div class="t2" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.role)}</div>
      </div>
      <div class="trail">${I("chevron-right", "s16")}</div>
    </div>`,
  ).join("");
  return `
  <section class="screen" data-route="bots">
    <div class="scroll">
      <div class="large-head">
        <div class="large-title">Bots</div>
        <div class="head-actions">
          <button class="round-add" data-new-bot aria-label="New bot">${I("plus")}</button>
        </div>
      </div>
      <div class="screen-body">${rows}</div>
    </div>
  </section>`;
}

function threadAskHTML(t) {
  if (sectionOf(t) !== "needs" || !t.ask) return "";
  if (t.ask === "question") {
    return `<div class="card approval-card">
      <div class="chead">${I("message-circle-question")}<span>Question</span></div>
      <div class="q">Which scope should the sweep cover?</div>
      <div class="btns">
        <button class="b-ghost" data-answer="${t.id}">Only changed files</button>
        <button class="b-ghost" data-answer="${t.id}">The whole Project</button>
      </div>
    </div>`;
  }
  return `<div class="card approval-card">
    <div class="chead">${I("shield-check")}<span>Approval needed</span></div>
    <div class="q">Run <code>npm test</code>?</div>
    <div class="btns">
      <button class="b-primary" data-approve="once" data-tid="${t.id}">Allow once</button>
      <button class="b-ghost" data-approve="always" data-tid="${t.id}">Always allow in this Project</button>
      <button class="b-danger" data-approve="deny" data-tid="${t.id}">Deny</button>
    </div>
  </div>`;
}

function threadLiveHTML(t) {
  const status = emptyCounts ? "finished" : t.status;
  if (!isConnected(t)) return `<span>Paused · ${compName(t.computer)} offline</span>`;
  if (status === "working")
    return `<span class="pulse-dot"></span><span>Working · ${t.elapsed}</span>`;
  if (status === "waiting") return `<span>Waiting for you · ${t.elapsed}</span>`;
  if (status === "failed") return `<span>Failed · ${t.elapsed} ago</span>`;
  return `<span>Finished · ${t.elapsed} ago</span>`;
}

function settledBannerHTML(t) {
  if (!t.settled) return "";
  return `<div class="settled-note"><span>Settled ${t.elapsed} ago</span>${isConnected(t) ? `<button data-unsettle="${t.id}">Un-settle</button>` : ""}</div>`;
}

function threadScreen(id = "sync") {
  const t = threadById(id);
  const comp = COMPUTERS[t.computer];
  const stale = comp.status === "stale";
  const dkey = `thread/${t.id}`;
  const attach = attachChipsHTML(dkey);
  return `
  <section class="screen dock${stale ? " stale" : ""}" data-route="thread/${t.id}">
    <div class="navbar">
      <button class="navbtn" data-back aria-label="Back">${I("chevron-left", "s20")}</button>
      <div class="navtitle">
        <div class="t" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
        <div class="s">${comp.name} · ${esc(t.project)} · ${t.id === "sync" ? "sync-worker" : t.id}</div>
      </div>
      <button class="navbtn" data-sheet="panes" aria-label="Panes">${I("panel-right", "s18")}</button>
      <button class="navbtn" data-menu="threadmore" aria-label="More">${I("more-horizontal", "s18")}</button>
    </div>
    ${stale ? `<div class="stale-banner"><span class="sb-dot"></span><span>${esc(comp.name)} was last seen ${esc(comp.sub.replace("Last seen ", ""))}. You can read this thread, but not change it.</span></div>` : ""}
    <div class="scroll">
      <div class="transcript">
        <div class="msg-user">Can you make the sync worker stop re-checking unchanged payloads? It is burning CPU on large repos.</div>
        <div class="md">
          <h2>Where the time goes</h2>
          <p>The worker re-hashes every queued entry on each pass. For large repos that is thousands of SHA-256 calls per second. Two cheap fixes get most of it back:</p>
          <ul>
            <li>Skip entries whose <code>mtime</code> and size are unchanged since the last pass.</li>
            <li>Batch signature verification so the worker does one disk read per file, not per entry.</li>
          </ul>
          <p>The hot loop currently looks like this:</p>
          <pre><span class="cmt">// sync/worker.ts</span>
for (const entry of queue) {
  const hash = await sha256(entry.path);
  if (hash !== entry.hash) await resend(entry);
}</pre>
          <p>I would add a <code>seen</code> map keyed by path, guarded by the file stats. Want me to go ahead?</p>
        </div>
        <div class="thought-row">${I("sparkles", "s14")}<span>Thought for 12s</span></div>
        <div class="toolrun">
          <button class="thead">
            ${I("terminal", "s14")}<span>Ran 3 commands</span>
            <span class="chev">${I("chevron-right", "s14")}</span>
          </button>
          <div class="tbody">
            <div class="cmd"><span class="prompt">$</span> bun run test --filter sync</div>
            <div class="cmd"><span class="prompt">$</span> bun run typecheck</div>
            <div class="cmd"><span class="prompt">$</span> git diff --stat main...HEAD</div>
          </div>
        </div>
        <div class="card">
          <div class="chead">${I("file-diff")}<span>Edited 2 files</span></div>
          <div class="csub">apps/server/src/sync/worker.ts · packages/shared/src/hash.ts</div>
          <div class="diffstat"><span class="add">+34</span><span class="del">−8</span></div>
        </div>
        <div class="t-ask">${threadAskHTML(t)}</div>
        <div class="live-status t-live">${threadLiveHTML(t)}</div>
      </div>
    </div>
    <div class="composer${stale ? " disabled" : ""}">
      <div class="t-settled">${settledBannerHTML(t)}</div>
      ${stale ? "" : attach}
      <div class="crow">
        <div class="field">
          ${stale ? "" : `<button class="cbtn" data-dead="Attach" aria-label="Attach">${I("plus")}</button>`}
          <input class="msg-input" type="text" aria-label="Message" placeholder="${stale ? `${comp.name} is offline` : "Message…"}" autocomplete="off" ${stale ? "disabled" : ""}>
          <button class="modelchip" data-sheet="model">${modelState.model} · ${modelState.effort} ${I("chevron-down", "s12")}</button>
          ${stale ? "" : `<button class="cbtn" data-dead="Voice input" aria-label="Voice input">${I("mic")}</button>`}
        </div>
        ${stale ? "" : `<button class="sendbtn" aria-label="Send">${I("arrow-up")}</button>`}
      </div>
    </div>
  </section>`;
}

function prScreen() {
  const p = PR2864;
  const segs = ["Overview", "Checks", "Files", "Commits", "Activity"];
  return `
  <section class="screen dock" data-route="pr/2864">
    <div class="navbar">
      <button class="navbtn" data-back aria-label="Back">${I("chevron-left", "s20")}</button>
      <div class="navtitle"><div class="t">Pull request</div></div>
      <button class="navbtn" data-menu="prmore" aria-label="More">${I("more-horizontal", "s18")}</button>
    </div>
    <div class="scroll">
      <div class="pr-hero">
        <span class="statebadge open">${I("git-pull-request", "s14")} Open</span>
        <div class="pr-title">${esc(p.title)} <span class="num">#${p.n}</span></div>
        <div class="branchrow">
          <span class="branchchip">${I("git-branch")}${esc(p.branch)}</span>
          ${I("arrow-right", "s14")}
          <span class="branchchip">${I("git-branch")}${esc(p.base)}</span>
        </div>
        <div class="statline"><span class="add">+${p.add}</span><span class="del">−${p.del}</span></div>
      </div>
      <div class="segbar" id="prsegs">
        ${segs.map((s, i) => `<button class="${i === 0 ? "on" : ""}" data-seg="${i}">${s}</button>`).join("")}
      </div>
      <div class="prbody" id="prseg-0">${prOverview(p)}</div>
      <div class="prbody" id="prseg-1" style="display:none">${prChecks(p)}</div>
      <div class="prbody" id="prseg-2" style="display:none">${prFiles(p)}</div>
      <div class="prbody" id="prseg-3" style="display:none">${prCommits(p)}</div>
      <div class="prbody" id="prseg-4" style="display:none">${prActivity(p)}</div>
    </div>
    <div class="praction">
      <button class="ghost-btn" data-dead="Comment">${I("message-square", "s15")} Comment</button>
      <button class="ghost-btn" data-menu="review" style="padding:0 12px">Review ${I("chevron-down", "s14")}</button>
      <button class="merge-btn" data-menu="mergeinfo">${I("git-merge")} Merge</button>
      <button class="icon-btn" data-menu="prmore2" aria-label="More actions">${I("more-horizontal")}</button>
    </div>
  </section>`;
}

function mdBlocks(blocks) {
  return blocks
    .map((b) => {
      if (b.t === "p") return `<p>${esc(b.x)}</p>`;
      if (b.t === "h") return `<h2>${esc(b.x)}</h2>`;
      if (b.t === "ul") return `<ul>${b.x.map((i) => `<li>${i}</li>`).join("")}</ul>`;
      if (b.t === "tasks")
        return `<ul class="task">${b.x
          .map(
            (i) => `
      <li class="${i.done ? "done" : ""}"><span class="box ${i.done ? "done" : ""}">${i.done ? I("check") : ""}</span><span>${esc(i.x)}</span></li>`,
          )
          .join("")}</ul>`;
      return "";
    })
    .join("");
}

function prOverview(p) {
  return `<div class="md">${mdBlocks(p.description)}</div>`;
}

function prChecks(p) {
  return `<div>${p.checks
    .map(
      (c) => `
    <div class="checkrow">
      <div class="ci ${c.state === "pass" ? "pass" : "pending"}">${I(c.state === "pass" ? "circle-check" : "clock-3")}</div>
      <div class="main">
        <div class="c1">${esc(c.name)}</div>
        <div class="c2 mono">${esc(c.sub)}</div>
      </div>
      <div class="when">${c.time}</div>
    </div>`,
    )
    .join("")}</div>`;
}

function prFiles(p) {
  return `<div>${p.files
    .map(
      (f) => `
    <div class="filecard${f.open ? " open" : ""}">
      <button class="filehead" data-file>
        ${I("file-code-2")}
        <span class="fname">${esc(f.path)}</span>
        <span class="st"><span class="a">+${f.add}</span> <span class="d">−${f.del}</span></span>
        <span class="chev">${I("chevron-down", "s14")}</span>
      </button>
      ${
        f.diff
          ? `<div class="filediff">${f.diff
              .map(([k, o, n]) => {
                const sign = k === "add" ? "+" : k === "del" ? "−" : " ";
                const cls = k === "add" ? "add" : k === "del" ? "del" : "ctx";
                return `<div class="dline ${cls}"><span class="ln">${o}</span><span class="pm">${sign}</span><span class="lc">${esc(n)}</span></div>`;
              })
              .join("")}</div>`
          : ""
      }
    </div>`,
    )
    .join("")}</div>`;
}

function prCommits(p) {
  return `<div>${p.commits
    .map(
      (c) => `
    <div class="commitrow">
      <div class="cavatar">${c.author[0].toUpperCase()}</div>
      <div class="cmain">
        <div class="cm1">${esc(c.msg)}</div>
        <div class="cm2"><span class="hash">${c.hash}</span><span>${esc(c.author)}</span><span>·</span><span>${c.time} ago</span></div>
      </div>
    </div>`,
    )
    .join("")}</div>`;
}

function prActivity(p) {
  return `<div>${p.activity
    .map(
      (a) => `
    <div class="actrow">
      <div class="cavatar">${a.who[0].toUpperCase()}</div>
      <div class="amain">
        <div class="a1"><b>${esc(a.who)}</b><span class="when">${a.when} ago</span></div>
        <div class="a2">${esc(a.text)}</div>
      </div>
    </div>`,
    )
    .join("")}</div>`;
}

function botAvatarHTML(b, size = 40) {
  return `<div class="bot-avatar" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${b.g1},${b.g2})">${I(b.glyph)}</div>`;
}

function botScreen(id = "bugscout") {
  const b = BOTS.find((x) => x.id === id) || BOTS[1];
  const isBug = b.id === "bugscout";
  const greets = isBug
    ? [
        "Hi, I'm Bug Scout.",
        "I find reproducible bugs, fix each one in a small tested change, and keep your review queue short.",
        "Which bugs should I hunt down next?",
      ]
    : [
        `Hi, I'm ${b.name}.`,
        b.lead
          ? "I watch your threads and pull requests, and surface what needs a decision before it slips."
          : "I work on one focused job and report back with proof.",
        b.role,
      ];
  const workrows = isBug
    ? [
        { icon: "bug", title: "Fix bugs with proof", sub: "Reproduce, fix and add a test" },
        { icon: "timer", title: "Check slow screens", sub: "Measure before and after" },
        { icon: "alarm-clock", title: "Start a daily sweep", sub: "Every morning at 9:00" },
      ]
    : [
        { icon: "star", title: "Watch my queue", sub: "Summarize what changed overnight" },
        { icon: "bell", title: "Nudge me on decisions", sub: "Only when something is blocked" },
        { icon: "list-checks", title: "Weekly digest", sub: "Every Friday at 17:00" },
      ];
  const dkey = `bot/${b.id}`;
  const attach = attachChipsHTML(dkey);
  return `
  <section class="screen dock" data-route="bot/${b.id}">
    <div class="navbar tall">
      <button class="navbtn" data-back aria-label="Back">${I("chevron-left", "s20")}</button>
      <div class="navtitle">
        <div class="bot-hero" style="padding:0">
          ${botAvatarHTML(b, 48)}
          <div class="namepill">${esc(b.name)}</div>
        </div>
      </div>
      <button class="navbtn" data-menu="botmore" aria-label="More">${I("more-horizontal", "s18")}</button>
    </div>
    <div class="scroll">
      <div class="transcript">
        ${greets.map((g) => `<div class="greet"><div class="bubble">${esc(g)}</div></div>`).join("")}
        <div class="card workcard">
          <div class="chead">${I("zap")}<span>Put ${esc(b.name)} to work</span></div>
          ${workrows
            .map(
              (w) => `
            <button class="workrow" data-dead="${esc(w.title)}">
              <div class="dest-ic">${I(w.icon)}</div>
              <div class="main"><div class="w1">${esc(w.title)}</div><div class="w2">${esc(w.sub)}</div></div>
              ${I("chevron-right", "s16")}
            </button>`,
            )
            .join("")}
        </div>
        <div class="sleep-status"><span class="dot"></span><span>${esc(b.name)} went to sleep</span></div>
      </div>
    </div>
    <div class="composer">
      ${attach}
      <div class="crow">
        <div class="field">
          <button class="cbtn" data-dead="Attach" aria-label="Attach">${I("plus")}</button>
          <input class="bot-input" type="text" aria-label="Message ${esc(b.name)}" placeholder="Message ${esc(b.name)}" autocomplete="off">
          <button class="cbtn" data-dead="Voice input" aria-label="Voice input">${I("mic")}</button>
        </div>
        <button class="callbtn" data-dead="Start voice call" aria-label="Voice call">${I("audio-waveform")}</button>
      </div>
    </div>
  </section>`;
}

/* ============================== settings & computer ============================== */

const ICON_ALIAS = {
  "scan-face": "shield-check",
  palette: "moon",
  "layout-grid": "rows-3",
  smartphone: "laptop",
  info: "circle-alert",
  scale: "file-text",
  network: "git-fork",
  user: "user-plus",
  "shield-off": "shield-check",
  server: "monitor",
  cpu: "monitor",
  wrench: "terminal",
};
const SET_ICON = {
  monitor: "var(--palette-blue)",
  bell: "var(--palette-orange)",
  "message-square": "var(--palette-teal)",
  "bell-dot": "var(--palette-yellow)",
  "message-circle-question": "var(--palette-blue)",
  "circle-x": "var(--danger-text)",
  "circle-check": "var(--success-text)",
  zap: "var(--palette-orange)",
  "rows-3": "var(--palette-teal)",
  moon: "var(--palette-purple)",
  image: "var(--palette-purple)",
  mic: "var(--palette-teal)",
  "shield-check": "var(--palette-green)",
  "eye-off": "var(--palette-yellow)",
  laptop: "var(--palette-blue)",
  "circle-alert": "var(--palette-yellow)",
  "file-text": "var(--text-secondary)",
  plus: "var(--accent)",
  "git-fork": "var(--palette-blue)",
  "user-plus": "var(--palette-purple)",
  "sliders-horizontal": "var(--palette-orange)",
  "trash-2": "var(--danger-text)",
  folder: "var(--text-secondary)",
  "git-branch": "var(--palette-blue)",
  "folder-git-2": "var(--text-secondary)",
  "file-diff": "var(--success-text)",
  "git-pull-request": "var(--palette-purple)",
  "git-commit-horizontal": "var(--text-secondary)",
  "file-code-2": "var(--text-secondary)",
  bot: "var(--palette-blue)",
  terminal: "var(--palette-orange)",
};
const setIcon = (name) => {
  const ic = ICON_ALIAS[name] ?? name;
  const col = SET_ICON[ic] ?? "var(--accent)";
  return `<span class="set-ic" style="background:color-mix(in srgb, ${col} 16%, transparent);color:${col}">${I(ic, "s15")}</span>`;
};

const demoPrefs = {};
const prefOn = (k, d) => (k in demoPrefs ? demoPrefs[k] : d);

function setRow(icon, label, trail = "", sub = "", opts = {}) {
  const chev =
    opts.push || opts.menu ? `<span class="set-chev">${I("chevron-right", "s14")}</span>` : "";
  const inner = `
    ${setIcon(icon)}
    <div class="set-main"><div class="set-label">${esc(label)}</div>${sub ? `<div class="set-sub">${esc(sub)}</div>` : ""}</div>
    ${trail}${chev}`;
  const cls = `set-row${opts.danger ? " danger" : ""}${opts.accent ? " accent" : ""}${opts.disabled ? " disabled" : ""}`;
  if (opts.sw) return `<label class="${cls}">${inner}</label>`;
  return opts.push || opts.dead || opts.menu || opts.action
    ? `<button class="${cls}" ${opts.menu ? `data-menu="${opts.menu}"` : opts.action ? `data-action="${opts.action}"` : opts.dead ? `data-dead="${esc(opts.dead)}"` : `data-push="${opts.push}"`}>${inner}</button>`
    : `<div class="${cls}">${inner}</div>`;
}
const setSwitch = (key, on) =>
  `<input class="set-switch" type="checkbox" role="switch" data-set="${key}"${on ? " checked" : ""}>`;
const setGroup = (rows) => `<div class="set-group">${rows.join("")}</div>`;
const setHeader = (t) => `<div class="set-head">${t}</div>`;
const setFooter = (t) => `<div class="set-foot">${t}</div>`;
const setSep = () => `<div class="set-sep"></div>`;

let themePref =
  localStorage.getItem("octant-mock-theme-pref") ||
  localStorage.getItem("octant-mock-theme") ||
  "dark";
function themeLabel() {
  return themePref === "system" ? "System" : themePref === "light" ? "Light" : "Dark";
}

function settingsScreen() {
  const notifRows = [
    setRow("bell-dot", "Approval needed", setSwitch("n-approval", prefOn("n-approval", true)), "", {
      sw: true,
    }),
    setSep(),
    setRow(
      "message-circle-question",
      "Waiting for you",
      setSwitch("n-waiting", prefOn("n-waiting", true)),
      "",
      { sw: true },
    ),
    setSep(),
    setRow("circle-x", "Failed", setSwitch("n-failed", prefOn("n-failed", false)), "", {
      sw: true,
    }),
    setSep(),
    setRow("circle-check", "Finished", setSwitch("n-finished", prefOn("n-finished", true)), "", {
      sw: true,
    }),
    setSep(),
    setRow("zap", "Live Activity", `<span class="set-val">On</span>`, "", {
      dead: "Not in this preview",
    }),
    setSep(),
    setRow("rows-3", "Widget data", `<span class="set-val">On</span>`, "", {
      dead: "Not in this preview",
    }),
  ];
  return `
  <section class="screen" data-route="settings">
    <div class="navbar">
      <button class="settings-back" data-back>${I("chevron-left", "s18")}Back</button>
    </div>
    <div class="scroll">
      <h1 class="settings-title">Settings</h1>
      ${setHeader("Computers")}
      ${setGroup([
        setRow(
          "monitor",
          "Studio Mac",
          `<span class="set-val set-connected">Connected</span>`,
          "Local network",
          { push: "computer/studio" },
        ),
        setSep(),
        setRow(
          "monitor",
          "Devbox",
          `<span class="set-val" style="color:var(--warning-text)">Last seen 2h ago</span>`,
          "",
          { push: "computer/devbox" },
        ),
        setSep(),
        setRow("plus", "Pair a computer", "", "", { accent: true, push: "pair" }),
      ])}
      ${setFooter("Computers Octant can reach on your network or tailnet.")}
      ${setHeader("Notifications")}
      ${setGroup([
        setRow("bell", "Notifications", setSwitch("notif", prefOn("notif", true)), "", {
          sw: true,
        }),
        setSep(),
        setRow("message-square", "Show thread names", setSwitch("names", showNames), "", {
          sw: true,
        }),
        setSep(),
        `<details class="set-disclosure"><summary class="set-row"><span class="set-ic" style="background:color-mix(in srgb, var(--palette-blue) 16%, transparent);color:var(--palette-blue)">${I("bell-dot", "s15")}</span><div class="set-main"><div class="set-label">Notification options</div></div><span class="set-chev">${I("chevron-right", "s14")}</span></summary><div>${notifRows.join("")}</div></details>`,
      ])}
      ${setFooter("Names appear on the Lock Screen, where anyone holding your phone can see them.")}
      <div class="set-foot" style="color:var(--success-text)">Sent by Studio Mac directly</div>
      ${setHeader("Appearance")}
      ${setGroup([
        setRow("moon", "Theme", `<span class="set-val">${themeLabel()}</span>`, "", {
          menu: "settheme",
        }),
        setSep(),
        setRow("image", "Background", `<span class="set-val">Off</span>`, "", { menu: "setbg" }),
      ])}
      ${setHeader("Voice")}
      ${setGroup([
        setRow("mic", "Dictation", `<span class="set-val">On</span>`, "Transcribed on Studio Mac", {
          dead: "Not in this preview",
        }),
      ])}
      ${setHeader("Privacy & security")}
      ${setGroup([
        setRow("shield-check", "Face ID to open", setSwitch("faceid", prefOn("faceid", true)), "", {
          sw: true,
        }),
        setSep(),
        setRow(
          "eye-off",
          "Hide in app switcher",
          setSwitch("hideapp", prefOn("hideapp", true)),
          "",
          { sw: true },
        ),
        setSep(),
        setRow("laptop", "Paired devices", `<span class="set-val">2</span>`, "", {
          dead: "Not in this preview",
        }),
      ])}
      ${setHeader("About")}
      ${setGroup([
        setRow("circle-alert", "Version", `<span class="set-val">0.2.0</span>`),
        setSep(),
        setRow("file-text", "Licences", "", "", { dead: "Not in this preview" }),
      ])}
      <div style="height:40px"></div>
    </div>
  </section>`;
}

function computerScreen(id = "studio") {
  const c = COMPUTERS[id] || COMPUTERS.studio;
  const stale = c.status === "stale";
  const sub = stale ? c.sub : c.sub;
  return `
  <section class="screen" data-route="computer/${id}">
    <div class="navbar">
      <button class="navbtn" data-back aria-label="Back">${I("chevron-left", "s20")}</button>
      <div class="navtitle"><div class="t">${esc(c.name)}</div></div>
    </div>
    <div class="scroll">
      <div class="comp-hero">
        <div class="comp-ic" style="width:52px;height:52px;border-radius:14px">${I("monitor", "s24")}</div>
        <div class="ch-name">${esc(c.name)}</div>
        <div class="ch-sub"><span class="${stale ? "stale-dot" : "live-dot"}"></span>${esc(sub)}</div>
      </div>
      <div class="set-head">Connection</div>
      ${setGroup([
        setRow(
          "network",
          "Address",
          `<span class="set-val mono">${id === "studio" ? "studio.local" : "devbox.local"}</span>`,
        ),
        setSep(),
        setRow("user", "Access", `<span class="set-val">Acts as you</span>`),
        setSep(),
        setRow("sliders-horizontal", "Default mode", `<span class="set-val">Ask first</span>`),
        setSep(),
        setRow(
          "circle-check",
          "Settle threads when they're done",
          `<span class="set-val">${SETTLES_WHEN_DONE[id] ? "On" : "Off"}</span>`,
        ),
      ])}
      ${setFooter(`Change this in Settings › General on ${esc(c.name)}.`)}
      <div class="set-head">This phone</div>
      ${setGroup([
        setRow("shield-off", "Revoke this phone", "", "", {
          danger: true,
          dead: "Revocation needs the computer online",
        }),
        setSep(),
        setRow("trash-2", "Remove from this phone", "", "", {
          danger: true,
          dead: "Remove this computer from Octant?",
        }),
      ])}
      <div style="height:40px"></div>
    </div>
  </section>`;
}

function pairScreen() {
  return `
  <section class="screen" data-route="pair">
    <div class="navbar">
      <button class="navbtn" data-back aria-label="Back">${I("chevron-left", "s20")}</button>
      <div class="navtitle"><div class="t">Pair a computer</div></div>
    </div>
    <div class="scroll">
      <div class="pair-view">
        <div class="vf">
          <span class="corner tl"></span><span class="corner tr"></span>
          <span class="corner bl"></span><span class="corner br"></span>
          <div class="scanline"></div>
          <div class="vf-mark">${I("scan-line", "s30")}</div>
        </div>
        <div class="pair-text">Scan the code shown in Settings › Remote access on your computer.</div>
      </div>
      <div class="pair-btns">
        <button class="big-btn ghost" data-sheet="paircode">Enter a code instead</button>
        <button class="big-btn ghost" data-sheet="pairdetails">Type the details instead</button>
      </div>
      <div style="height:40px"></div>
    </div>
  </section>`;
}

/* ============================== device pages (Lock / Home Screen / Android notif) ============================== */

/* The expanded island names the first thread waiting on the user, and says
   nothing when no thread is waiting. */
function islandNeeds() {
  const first = threadsIn("needs")[0];
  if (!first) return "";
  const label = showNames ? first.title : `a thread on ${compName(first.computer)}`;
  return `<div class="isl-needs">Needs you: ${esc(label)}</div>`;
}

function lockScreen() {
  const { active, needs } = awareCounts();
  const rows = aware().slice(0, 5).map(awareRow).join("");
  const islandCompact = `<div class="isl isl-compact"><img src="../../assets/icon.png" alt="">${showNames ? "" : '<span class="isl-g">' + I("bot", "s10") + "</span>"}<span class="isl-n">${active}</span></div>`;
  const islandMinimal = `<div class="isl isl-minimal">${I("bot", "s12")}</div>`;
  const islandExpanded = `<div class="isl isl-expanded">
      <div class="isl-top"><img src="../../assets/icon.png" alt="" class="isl-logo"><span class="isl-count">${active} agents</span></div>
      ${aware()
        .slice(0, 2)
        .map((a) => {
          const t = threadById(a.tid);
          const nm = showNames ? t.title : `Thread on ${compName(t.computer)}`;
          return `<div class="isl-row"><span class="isl-t">${esc(nm.length > 26 ? nm.slice(0, 26) + "…" : nm)}</span><span class="isl-s" style="color:${PHASE_COLOR[a.phase]}">${a.status}</span></div>`;
        })
        .join("")}
      ${islandNeeds()}
    </div>`;
  return `
  <section class="screen device" data-route="lock">
    <div class="wallpaper"></div>
    <div class="lock-body">
      <div class="lock-date">Tuesday 25 November</div>
      <div class="lock-clock">9:41</div>
      <div class="la-card" id="la-card">
        <div class="la-head">
          <img src="../../assets/icon.png" alt="" class="la-logo">
          <span class="la-title" id="la-title">${active} active agents · ${needs} needs you</span>
          <button class="la-stale" id="la-stale">Out of date</button>
        </div>
        <div class="la-rows" id="la-rows">${rows}</div>
      </div>
      <div class="isl-label">Dynamic Island</div>
      <div class="isl-row-wrap">
        <div class="isl-col"><div class="isl-cap">compact</div>${islandCompact}</div>
        <div class="isl-col"><div class="isl-cap">minimal</div>${islandMinimal}</div>
        <div class="isl-col"><div class="isl-cap">expanded</div>${islandExpanded}</div>
      </div>
    </div>
    <div class="lock-homebar"></div>
  </section>`;
}

function widgetScreen() {
  const { active, needs } = awareCounts();
  const smallRows = aware()
    .slice(0, 2)
    .map((a) => {
      const t = threadById(a.tid);
      const nm = showNames ? t.title : `Thread on ${compName(t.computer)}`;
      return `<div class="wg-row"><span class="wg-t">${esc(nm.length > 22 ? nm.slice(0, 22) + "…" : nm)}</span><span class="wg-s" style="color:${PHASE_COLOR[a.phase]}">${a.status}</span></div>`;
    })
    .join("");
  const medRows = aware()
    .slice(0, 4)
    .map((a) => {
      const t = threadById(a.tid);
      const nm = showNames ? t.title : `Thread on ${compName(t.computer)}`;
      return `<div class="wg-row"><span class="wg-t">${esc(nm.length > 30 ? nm.slice(0, 30) + "…" : nm)}</span><span class="wg-s" style="color:${PHASE_COLOR[a.phase]}">${a.status}</span></div>`;
    })
    .join("");
  const icons = [
    "message-square",
    "bot",
    "git-pull-request",
    "inbox",
    "settings",
    "search",
    "image",
    "map",
    "music",
    "camera",
    "mail",
    "calendar",
    "clock",
    "cloud",
    "folder",
    "globe",
    "phone",
    "video",
    "wallet",
    "book",
    "gamepad-2",
    "newspaper",
    "shopping-bag",
    "heart-pulse",
  ];
  const grid = icons.map((ic) => `<div class="appicon">${I(ic, "s22")}</div>`).join("");
  return `
  <section class="screen device" data-route="homescreen">
    <div class="wallpaper wp-home"></div>
    <div class="hs-grid">${grid}</div>
    <div class="hs-widgets">
      <div class="wg wg-small">
        <div class="wg-head"><img src="../../assets/icon.png" alt=""><span class="wg-count">${active}</span><span class="wg-sub">· ${needs} needs you</span></div>
        ${smallRows}
      </div>
      <div class="wg wg-medium">
        <div class="wg-head"><img src="../../assets/icon.png" alt=""><span class="wg-count">${active} agents</span><span class="wg-sub">· ${needs} needs you</span></div>
        ${medRows}
      </div>
    </div>
    <div class="lock-homebar"></div>
  </section>`;
}

function androidNotifScreen() {
  const { active, needs } = awareCounts();
  const rows = aware()
    .slice(0, 4)
    .map((a) => {
      const t = threadById(a.tid);
      const nm = showNames ? t.title : `Thread on ${compName(t.computer)}`;
      return `<div class="an-row"><span class="an-dot" style="background:${PHASE_COLOR[a.phase]}"></span><span class="an-t">${esc(nm.length > 30 ? nm.slice(0, 30) + "…" : nm)}</span><span class="an-s" style="color:${PHASE_COLOR[a.phase]}">${a.status}</span></div>`;
    })
    .join("");
  return `
  <section class="screen device" data-route="android-notification">
    <div class="wallpaper wp-android"></div>
    <div class="an-shade">
      <div class="an-time">9:41</div>
      <div class="an-date">Tue, Nov 25</div>
      <div class="an-card">
        <div class="an-head">
          <img src="../../assets/icon.png" alt="" class="an-logo">
          <div class="an-app"><div class="an-appname">Octant</div><div class="an-appsub">Live Update · now</div></div>
        </div>
        <div class="an-title">${active} working · ${needs} needs you</div>
        <div class="an-rows">${rows}</div>
        <div class="an-actions"><button class="an-open">Open</button></div>
      </div>
      <div class="an-hint">Material notification shade · fictional preview</div>
    </div>
  </section>`;
}

/* ============================== panes component ============================== */

const PANES_FILES = [
  { path: "apps/server/src/sync/worker.ts", add: 20, del: 5, diff: PR2864.files[0].diff },
  { path: "packages/shared/src/hash.ts", add: 14, del: 3, diff: null },
];
const PANES_COMMITS = PR2864.commits.slice(0, 3);

function panesContentHTML() {
  const { seg, view, file } = panesState;
  if (view === "diff" && file) {
    return `
    <div class="panes-subhead">
      <button class="panes-back" data-panes="back">${I("chevron-left", "s16")} Files</button>
    </div>
    <div class="panes-diff">
      <div class="pd-path mono">${esc(file.path)}</div>
      <div class="pd-stat"><span class="add">+${file.add}</span><span class="del">−${file.del}</span></div>
      ${
        file.diff
          ? file.diff
              .map(([k, o, n]) => {
                const sign = k === "add" ? "+" : k === "del" ? "−" : " ";
                const cls = k === "add" ? "add" : k === "del" ? "del" : "ctx";
                return `<div class="dline ${cls}"><span class="ln">${o}</span><span class="pm">${sign}</span><span class="lc">${esc(n)}</span></div>`;
              })
              .join("")
          : `<div class="pd-nodiff">Diff not available in this preview.</div>`
      }
    </div>`;
  }
  if (seg === 0) {
    return `
    <div class="panes-list">
      ${setRow("folder", "Project", `<span class="set-val">octant</span>`)}
      ${setRow("git-branch", "Branch", `<span class="set-val mono">sync-worker</span>`)}
      ${setRow("folder-git-2", "Worktree", `<span class="set-val mono" style="font-size:11.5px">.worktrees/sync</span>`)}
      <button class="set-row" data-panes="review">
        <span class="set-ic" style="background:color-mix(in srgb, var(--success-text) 14%, transparent);color:var(--success-text)">${I("file-diff")}</span>
        <div class="set-main"><div class="set-label">Uncommitted changes</div></div>
        <span class="set-val"><span class="add">+34</span> <span class="del">−8</span></span>
        ${I("chevron-right", "s14")}
      </button>
      ${setRow("server", "Local servers", `<span class="set-val mono">Vite · :5173</span>`)}
      ${setRow("bot", "Subagents", `<span class="set-val">2 working · 1 done</span>`)}
      <button class="set-row" data-dead="Open pull request #2864">
        <span class="set-ic" style="background:color-mix(in srgb, var(--palette-purple) 14%, transparent);color:var(--palette-purple)">${I("git-pull-request")}</span>
        <div class="set-main"><div class="set-label">Pull request</div></div>
        <span class="set-val mono">#2864</span><span class="pill ok" style="margin-left:6px">Open</span>
        ${I("chevron-right", "s14")}
      </button>
    </div>`;
  }
  if (seg === 1) {
    return `
    <div class="panes-list">
      ${PANES_FILES.map(
        (f) => `
      <button class="set-row" data-panes-file="${PANES_FILES.indexOf(f)}">
        <span class="set-ic" style="background:var(--control);color:var(--text-secondary)">${I("file-code-2")}</span>
        <div class="set-main"><div class="set-label mono" style="font-size:12.5px">${esc(f.path)}</div></div>
        <span class="set-val"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span>
        ${I("chevron-right", "s14")}
      </button>`,
      ).join("")}
      <div class="set-head" style="padding-top:16px">Recent commits</div>
      ${PANES_COMMITS.map(
        (c) => `
      <div class="set-row">
        <span class="set-ic" style="background:var(--control);color:var(--text-secondary)">${I("git-commit-horizontal")}</span>
        <div class="set-main"><div class="set-label" style="font-weight:500">${esc(c.msg)}</div><div class="set-sub mono">${c.hash} · ${c.time} ago</div></div>
      </div>`,
      ).join("")}
    </div>`;
  }
  if (seg === 2) {
    return `
    <div class="panes-list">
      <div class="ctx-bar"><div class="ctx-fill" style="width:62%"></div><span class="ctx-label">62% · 124k of 200k</span></div>
      ${setRow("cpu", "System", `<span class="set-val">42k</span>`)}
      ${setRow("message-square", "Conversation", `<span class="set-val">68k</span>`)}
      ${setRow("wrench", "Tools", `<span class="set-val">9k</span>`)}
      ${setRow("folder", "Files", `<span class="set-val">5k</span>`)}
      <div class="set-foot" style="padding:12px 18px 0">Compacts automatically near the limit.</div>
    </div>`;
  }
  return `
  <div class="panes-list">
    <div class="agents-counts">
      <div class="ac"><span class="ac-n" style="color:var(--palette-orange)">2</span><span class="ac-l">Working</span></div>
      <div class="ac"><span class="ac-n" style="color:var(--palette-blue)">1</span><span class="ac-l">To review</span></div>
      <div class="ac"><span class="ac-n" style="color:var(--success-text)">3</span><span class="ac-l">Done</span></div>
      <div class="ac"><span class="ac-n" style="color:var(--danger-text)">0</span><span class="ac-l">Failed</span></div>
    </div>
    <div class="set-head">Latest</div>
    <div class="set-row">
      <span class="set-ic" style="background:color-mix(in srgb, var(--palette-blue) 14%, transparent);color:var(--palette-blue)">${I("bot")}</span>
      <div class="set-main"><div class="set-label">Navigator</div><div class="set-sub">Summarized overnight changes across 4 threads · 6m ago</div></div>
    </div>
    <div class="set-row">
      <span class="set-ic" style="background:color-mix(in srgb, var(--palette-orange) 14%, transparent);color:var(--palette-orange)">${I("bug")}</span>
      <div class="set-main"><div class="set-label">Bug Scout</div><div class="set-sub">Reproduced a pairing flake on Devbox · 22m ago</div></div>
    </div>
  </div>`;
}

const PANE_SEGS = ["Environment", "Review", "Context", "Agents"];
function inspectorHTML() {
  return `<div class="segmented panes-seg">${PANE_SEGS.map((s, i) => `<button class="${i === panesState.seg ? "on" : ""}" data-panes-seg="${i}">${s}</button>`).join("")}</div>${panesContentHTML()}`;
}
function refreshPanesHosts() {
  $$(".panes-host", viewport).forEach((h) => {
    h.innerHTML = inspectorHTML();
  });
}

function panesSheetHTML() {
  const segs = PANE_SEGS;
  return `
  <div class="grabber"></div>
  <div class="sheet-head">
    <div class="sh-title">Panes</div>
    ${panesState.view !== "root" ? `<button class="panes-back" data-panes="back" style="position:static">${I("x", "s16")} Close</button>` : ""}
  </div>
  <div class="segmented panes-seg" id="panes-seg">
    ${segs.map((s, i) => `<button class="${i === panesState.seg ? "on" : ""}" data-panes-seg="${i}">${s}</button>`).join("")}
  </div>
  <div class="scroll panes-scroll" id="panes-body">${panesContentHTML()}</div>`;
}

/* ============================== sheets ============================== */

const drafts = new Map();
const getDrafts = (key) => {
  if (!drafts.has(key)) drafts.set(key, []);
  return drafts.get(key);
};

function attachChipsHTML(key) {
  const list = getDrafts(key);
  if (!list.length) return "";
  return `<div class="attachchips">${list
    .map(
      (a, i) => `
    <span class="attachchip">${I(a.icon)}<span>${esc(a.name)}</span>
      <button data-unattach="${i}" aria-label="Remove">${I("x")}</button>
    </span>`,
    )
    .join("")}</div>`;
}

/* What is typed and what is attached belong to the conversation, so every pane
   that shows it shows the same draft. */
const textDrafts = new Map();
function restoreDraft(s) {
  const input = s.el.querySelector(".composer input");
  if (input && textDrafts.get(s.route)) {
    input.value = textDrafts.get(s.route);
    syncSend(s.el);
  }
}
function syncSend(screen) {
  const input = screen.querySelector(".msg-input");
  screen
    .querySelector(".sendbtn")
    ?.classList.toggle("show", !!input && input.value.trim().length > 0);
}

function refreshComposerChips(route) {
  allScreens()
    .filter((s) => s.route === route)
    .forEach((s) => {
      const comp = s.el.querySelector(".composer");
      if (!comp) return;
      comp.querySelector(".attachchips")?.remove();
      const html = attachChipsHTML(route);
      if (html) comp.querySelector(".crow").insertAdjacentHTML("beforebegin", html);
    });
}

const SHARE_ITEMS = [
  { name: "Photo · IMG_4821", icon: "image" },
  { name: "Photo · IMG_4822", icon: "image" },
  { name: "Spec.pdf", icon: "file-text" },
];

function newSheetHTML() {
  return `
  <div class="grabber"></div>
  <div class="segmented" id="newsheet-seg">
    <button class="on" data-nseg="0">Chat</button>
    <button data-nseg="1">In a folder</button>
    <button data-nseg="2">Code</button>
  </div>
  <div>
    <button class="formrow" data-menu="sheetcomputer"><span class="flabel">Computer</span><span class="fval">Studio Mac ${I("chevron-down")}</span></button>
    <div class="form-sep"></div>
    <button class="formrow" data-menu="sheetproject"><span class="flabel">Project</span><span class="fval">octant ${I("chevron-down")}</span></button>
    <div class="form-sep"></div>
    <button class="formrow" data-menu="sheetmodel"><span class="flabel">Model</span><span class="fval">Opus · High ${I("chevron-down")}</span></button>
  </div>
  <div class="new-attach">${attachChipsHTML("__new")}</div>
  <textarea class="promptarea" placeholder="What should we work on?" rows="3"></textarea>
  <button class="big-btn" id="sheet-start">Start</button>`;
}

function sendSheetHTML() {
  const threads = [
    { id: "sync" },
    { id: "pairing" },
    { id: "botsplan", disabled: true },
    { id: "payload" },
  ];
  const bots = BOTS.filter((b) => ["navigator", "bugscout"].includes(b.id));
  return `
  <div class="grabber"></div>
  <div class="attach-strip">
    <div class="thumb g1">${I("image")}</div>
    <div class="thumb g2">${I("image")}</div>
    <div class="thumb"><div class="pdf">${I("file-text")}<span>Spec.pdf</span></div></div>
  </div>
  <button class="comp-chip" data-menu="sheetcomputer">${I("monitor")} Studio Mac ${I("chevron-down", "s12")}</button>
  <div class="send-search">${I("search", "s16")}<input placeholder="Search threads and bots" autocomplete="off"></div>
  <div class="scroll">
    <div class="section-label" style="padding-top:8px">New chat</div>
    <button class="destrow" data-dest="__new">
      <div class="dest-ic">${I("square-pen")}</div>
      <div class="main"><div class="d1">New chat</div><div class="d2">Start a fresh thread on Studio Mac</div></div>
    </button>
    <div class="section-label">Threads</div>
    ${threads
      .map(({ id, disabled }) => {
        const t = threadById(id);
        return `
      <button class="destrow${disabled ? " disabled" : ""}" data-dest="${disabled ? "__disabled" : "thread/" + t.id}">
        ${modeBadge(t.mode)}
        <div class="main"><div class="d1"${disabled ? ' style="color:var(--text-muted)"' : ""}>${esc(t.title)}</div>
        <div class="d2">${disabled ? "PDFs can't be added to a Work thread" : compName(t.computer) + " · " + esc(t.project)}</div></div>
      </button>`;
      })
      .join("")}
    <div class="section-label">Bots</div>
    ${bots
      .map(
        (b) => `
      <button class="destrow" data-dest="bot/${b.id}">
        ${botAvatarHTML(b, 30)}
        <div class="main"><div class="d1">${esc(b.name)}</div><div class="d2">${esc(b.role)}</div></div>
      </button>`,
      )
      .join("")}
    <div style="height:30px"></div>
  </div>`;
}

/* ============================== screens by route ============================== */

// A Map, so a route name read from the address (#/constructor) finds no
// builder rather than a property every object has.
const SCREEN_BUILDERS = new Map(
  Object.entries({
    home: homeScreen,
    threads: threadsScreen,
    list: (key) => countScreen(key || "needs"),
    inbox: inboxScreen,
    prs: prsScreen,
    bots: botsScreen,
    thread: (id) => threadScreen(id || "sync"),
    pr: () => prScreen(),
    bot: (id) => botScreen(id || "bugscout"),
    settings: settingsScreen,
    computer: (id) => computerScreen(id || "studio"),
    pair: pairScreen,
    lock: lockScreen,
    homescreen: widgetScreen,
    "android-notification": androidNotifScreen,
  }),
);
function buildScreen(routeStr) {
  const { name, arg } = parseRoute(routeStr);
  const builder = SCREEN_BUILDERS.get(name);
  // An address naming no screen opens Home, built like any other screen.
  if (typeof builder !== "function") return buildScreen("home");
  const html = ["thread", "bot", "computer", "list"].includes(name) ? builder(arg) : builder();
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const el = tmp.firstElementChild;
  if (name === "thread") renderConversation(el, routeStr);
  return el;
}

/* A thread's transcript is fixture markup plus what the user did to it here:
   replies they sent and how many fixture entries a rewind kept. Screens rebuild
   from this, so a reply survives switching tabs and shows in every pane. The
   question and live status are part of the thread, not entries, and stay. */
const conversations = new Map();
const PERMANENT_ENTRIES = ".t-ask, .t-live";
function conversationOf(route) {
  let c = conversations.get(route);
  if (!c) {
    c = { keptFixtures: null, sent: [] };
    conversations.set(route, c);
  }
  return c;
}
const conversationEntries = (transcript) =>
  [...transcript.children].filter((e) => !e.matches(PERMANENT_ENTRIES));
function sentMessageEl(text) {
  const div = document.createElement("div");
  div.className = "msg-user";
  div.dataset.sent = "";
  div.textContent = text;
  return div;
}
function renderConversation(screenEl, route) {
  const transcript = screenEl.querySelector(".transcript");
  const c = conversations.get(route);
  if (!transcript || !c) return;
  if (c.keptFixtures !== null)
    conversationEntries(transcript)
      .slice(c.keptFixtures)
      .forEach((e) => e.remove());
  const anchor = transcript.querySelector(".t-live");
  c.sent.forEach((text) => transcript.insertBefore(sentMessageEl(text), anchor));
}

/* ============================== thread state ============================== */

/* Redraw everything that counts or lists threads, in every pane. */
function refreshData() {
  allScreens().forEach((s) => {
    const { name, arg } = parseRoute(s.route);
    if (name === "thread") {
      const t = threadById(arg);
      s.el.querySelector(".navtitle .t").textContent = t.title;
      s.el.querySelector(".t-ask").innerHTML = threadAskHTML(t);
      s.el.querySelector(".t-live").innerHTML = threadLiveHTML(t);
      s.el.querySelector(".t-settled").innerHTML = settledBannerHTML(t);
      return;
    }
    if (!["home", "threads", "list", "inbox"].includes(name)) return;
    const fresh = buildScreen(s.route);
    const actions = s.el.querySelector(".split-btn");
    const sc = s.el.querySelector(":scope > .scroll");
    const y = sc.scrollTop;
    const inner = sc.querySelector(".scroll-in");
    inner.replaceChildren(...fresh.querySelector(".scroll").childNodes);
    const navbar = fresh.querySelector(".navbar");
    if (navbar)
      s.el.querySelector(".navbar .navtitle").innerHTML =
        navbar.querySelector(".navtitle").innerHTML;
    else {
      let host = inner.querySelector(".head-actions");
      if (!host) {
        host = document.createElement("div");
        host.className = "head-actions";
        inner.querySelector(".large-head").appendChild(host);
      }
      host.appendChild(actions);
    }
    sc.scrollTop = y;
  });
  if (deviceRoute) showDevicePage(deviceRoute);
  layoutPanes();
}

/* opening a thread moves its read cursor */
function markRead(t) {
  if (!t.unread) return;
  t.unread = false;
  refreshData();
}

function setRest(t, action) {
  const refused =
    ["settle", "snooze"].includes(action) || !isConnected(t) ? restRefusal(t, action) : null;
  if (refused) {
    toast(refused);
    return false;
  }
  if (action === "settle") {
    t.settled = true;
    t.snoozed = false;
  }
  if (action === "unsettle") t.settled = false;
  if (action === "snooze") t.snoozed = true;
  if (action === "wake") t.snoozed = false;
  toast(
    {
      settle: "Thread settled",
      unsettle: "Thread un-settled",
      snooze: "Snoozed until tomorrow",
      wake: "Thread woken",
    }[action],
  );
  refreshData();
  return true;
}

function answerAsk(t) {
  t.status = "working";
  t.ask = undefined;
  t.elapsed = "now";
  refreshData();
}

/* ============================== sheets & menus ============================== */

const sheetRoot = $("#sheet-root");
let openSheet = null;
let sheetDrag = null;

const EXTRA_SHEETS = {
  panes: panesSheetHTML,
  model: modelSheetHTML,
  paircode: paircodeSheetHTML,
  pairdetails: pairdetailsSheetHTML,
  rewind: rewindSheetHTML,
};

function openSheetEl(kind) {
  closeMenus();
  closeAlert();
  const html =
    kind === "new"
      ? newSheetHTML()
      : kind === "send"
        ? sendSheetHTML()
        : EXTRA_SHEETS[kind]
          ? EXTRA_SHEETS[kind]()
          : "";
  sheetRoot.innerHTML = `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet${kind === "panes" ? " sheet-tall" : ""}" id="sheet">
      ${html}
    </div>`;
  sheetRoot.classList.add("open");
  openSheet = kind;
  updateSafeArea();
  const sheet = $("#sheet");
  sheet.addEventListener("pointerdown", onSheetPointerDown);
  bindSheetContent(sheet, kind);
}

function closeSheet() {
  if (!openSheet) return;
  sheetRoot.classList.add("closing");
  setTimeout(() => {
    sheetRoot.classList.remove("open", "closing");
    sheetRoot.innerHTML = "";
    openSheet = null;
  }, 300);
}

function onSheetPointerDown(e) {
  // only start drag from grabber zone (top 30px of sheet)
  const sheet = $("#sheet");
  const rect = sheet.getBoundingClientRect();
  if (e.clientY - rect.top > 34) return;
  sheetDrag = { y: e.clientY, dy: 0 };
  const move = (ev) => {
    if (!sheetDrag) return;
    sheetDrag.dy = Math.max(0, ev.clientY - sheetDrag.y);
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${sheetDrag.dy}px)`;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!sheetDrag) return;
    const dy = sheetDrag.dy;
    sheetDrag = null;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (dy > 90) closeSheet();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function bindSheetContent(sheet, kind) {
  if (kind === "new") {
    $$("#newsheet-seg button", sheet).forEach((b) =>
      b.addEventListener("click", () => {
        $$("#newsheet-seg button", sheet).forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      }),
    );
    // items shared into New chat wait here until the chat starts or they are removed
    sheet.querySelector(".new-attach").addEventListener("click", (e) => {
      const un = e.target.closest("[data-unattach]");
      if (!un) return;
      e.stopPropagation();
      getDrafts("__new").splice(+un.dataset.unattach, 1);
      sheet.querySelector(".new-attach").innerHTML = attachChipsHTML("__new");
    });
    $("#sheet-start", sheet).addEventListener("click", () => {
      const prompt = sheet.querySelector(".promptarea").value.trim();
      const started = prompt || getDrafts("__new").length > 0;
      if (started) getDrafts("__new").length = 0;
      closeSheet();
      if (started) setTimeout(() => toast("Thread started"), 320);
    });
  } else if (kind === "send") {
    $$("[data-dest]", sheet).forEach((el) =>
      el.addEventListener("click", () => {
        const dest = el.dataset.dest;
        if (dest === "__disabled") return;
        if (dest === "__new") {
          getDrafts("__new").push(...SHARE_ITEMS.map((s) => ({ name: s.name, icon: s.icon })));
          closeSheet();
          setTimeout(() => openSheetEl("new"), 320);
          return;
        }
        getDrafts(dest).push(...SHARE_ITEMS.map((s) => ({ name: s.name, icon: s.icon })));
        closeSheet();
        setTimeout(() => {
          if (topScreen() && topScreen().route === dest) refreshComposerChips(dest);
          else {
            refreshComposerChips(dest);
            go("#/" + dest);
          }
        }, 300);
      }),
    );
    const search = $(".send-search input", sheet);
    if (search)
      search.addEventListener("input", () => {
        const q = search.value.toLowerCase();
        $$(".destrow", sheet).forEach((r) => {
          r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      });
  }
  if (kind === "panes") bindPanesSheet(sheet);
  if (kind === "model") bindModelSheet(sheet);
  if (kind === "paircode" || kind === "pairdetails") {
    $$("[data-pair-go]", sheet).forEach((b) =>
      b.addEventListener("click", () => {
        closeSheet();
        setTimeout(() => toast(kind === "paircode" ? "Comparing codes…" : "Connecting…"), 300);
      }),
    );
  }
  if (kind === "rewind") {
    $("[data-rewind-go]", sheet)?.addEventListener("click", () => {
      closeSheet();
      setTimeout(doRewind, 300);
    });
  }
}

/* ---------- panes sheet ---------- */

function bindPanesSheet(sheet) {
  const refresh = () => {
    const seg = $("#panes-seg", sheet);
    const body = $("#panes-body", sheet);
    if (seg)
      seg.innerHTML = ["Environment", "Review", "Context", "Agents"]
        .map(
          (s, i) =>
            `<button class="${i === panesState.seg ? "on" : ""}" data-panes-seg="${i}">${s}</button>`,
        )
        .join("");
    if (body) body.innerHTML = panesContentHTML();
    const head = sheet.querySelector(".sheet-head");
    if (head)
      head.innerHTML = `<div class="sh-title">Panes</div>${panesState.view !== "root" ? `<button class="panes-back" data-panes="back" style="position:static">${I("x", "s16")} Close</button>` : ""}`;
  };
  sheet.addEventListener("click", (e) => {
    const segBtn = e.target.closest("[data-panes-seg]");
    if (segBtn) {
      panesState.seg = +segBtn.dataset.panesSeg;
      panesState.view = "root";
      refresh();
      return;
    }
    const fileBtn = e.target.closest("[data-panes-file]");
    if (fileBtn) {
      panesState.file = PANES_FILES[+fileBtn.dataset.panesFile];
      panesState.view = "diff";
      refresh();
      return;
    }
    if (e.target.closest("[data-panes='review']")) {
      panesState.seg = 1;
      panesState.view = "root";
      refresh();
      return;
    }
    if (e.target.closest("[data-panes='back']")) {
      if (panesState.view === "diff") {
        panesState.view = "root";
        panesState.file = null;
      }
      refresh();
      return;
    }
  });
}

/* ---------- model sheet ---------- */

function modelSheetHTML() {
  const groups = MODEL_GROUPS.map(
    (g) => `
    <div class="set-head">${g.provider}</div>
    <div class="set-group">
      ${g.models
        .map(
          (m) => `
        <button class="set-row" data-model="${esc(m)}">
          <span class="set-ic" style="background:var(--control);color:var(--text-secondary)">${I("bot", "s15")}</span>
          <div class="set-main"><div class="set-label">${esc(m)}</div></div>
          ${modelState.model === m ? `<span style="color:var(--accent)">${I("check", "s16")}</span>` : ""}
        </button>`,
        )
        .join("")}
    </div>`,
  ).join("");
  return `
  <div class="grabber"></div>
  <div class="sheet-head"><div class="sh-title">Model</div></div>
  <div class="scroll" style="padding-bottom:20px">
    ${groups}
    <div class="set-head">Reasoning</div>
    <div class="set-group" style="padding:4px">
      <div class="segmented" id="effort-seg" style="margin:0 8px">
        ${EFFORTS.map((e) => `<button class="${modelState.effort === e ? "on" : ""}" data-effort="${e}">${e}</button>`).join("")}
      </div>
    </div>
  </div>`;
}

function bindModelSheet(sheet) {
  const syncChip = () => {
    for (const chip of $$(".modelchip"))
      chip.innerHTML = `${modelState.model} · ${modelState.effort} ${I("chevron-down", "s12")}`;
  };
  sheet.addEventListener("click", (e) => {
    const mb = e.target.closest("[data-model]");
    if (mb) {
      modelState.model = mb.dataset.model;
      $$("[data-model]", sheet).forEach((b) => {
        const on = b.dataset.model === modelState.model;
        b.querySelector(".set-ic + .set-main")?.parentElement;
        let chk = b.querySelector(".pick-check");
        if (on && !chk) {
          chk = document.createElement("span");
          chk.className = "pick-check";
          chk.style.color = "var(--accent)";
          chk.innerHTML = I("check", "s16");
          b.appendChild(chk);
        }
        if (!on && chk) chk.remove();
      });
      syncChip();
      return;
    }
    const eb = e.target.closest("[data-effort]");
    if (eb) {
      modelState.effort = eb.dataset.effort;
      $$("#effort-seg button", sheet).forEach((b) => b.classList.toggle("on", b === eb));
      syncChip();
    }
  });
}

/* ---------- pair sheets ---------- */

function paircodeSheetHTML() {
  return `
  <div class="grabber"></div>
  <div class="sheet-head"><div class="sh-title">Enter a code</div></div>
  <div class="scroll" style="padding:4px 20px 24px">
    <div class="pair-field">
      <label>Pairing code</label>
      <input class="code-input" placeholder="XXXX-XXXX" autocomplete="off">
    </div>
    <div class="compare-code">Compare on your computer: <b>4F7-K2Q</b></div>
    <button class="big-btn accent" data-pair-go>Pair</button>
  </div>`;
}

function pairdetailsSheetHTML() {
  return `
  <div class="grabber"></div>
  <div class="sheet-head"><div class="sh-title">Connection details</div></div>
  <div class="scroll" style="padding:4px 20px 24px">
    <div class="pair-field"><label>Address</label><input placeholder="studio.local" autocomplete="off"></div>
    <div class="pair-field"><label>Pairing code</label><input placeholder="XXXX-XXXX" autocomplete="off"></div>
    <button class="big-btn accent" data-pair-go>Pair</button>
  </div>`;
}

/* ---------- rewind ---------- */

let msgTargetEl = null;

function rewindSheetHTML() {
  return `
  <div class="grabber"></div>
  <div class="rewind-body">
    <div class="rw-icon">${I("history", "s26")}</div>
    <div class="rw-title">Rewind to this message?</div>
    <div class="rw-text">The 2 later messages are removed, and your message returns to the composer.</div>
    <div class="rw-btns">
      <button class="rw-cancel" data-close-sheet>Cancel</button>
      <button class="rw-go" data-rewind-go>Rewind</button>
    </div>
  </div>`;
}

function doRewind() {
  const t = msgTargetEl;
  // The thread may have left the screen while its sheet stayed open (browser
  // Back), so this is asked before anything is read from its screen.
  if (!t || !t.isConnected || !screenOf(t)) {
    toast("Nothing to rewind");
    return;
  }
  if (routeStale(screenOf(t).route)) {
    toast("This thread is read-only while its computer is offline");
    return;
  }
  const transcript = t.closest(".transcript");
  if (!transcript) return;
  const route = screenOf(t).route;
  const entries = conversationEntries(transcript);
  const at = entries.indexOf(t);
  if (at < 0) {
    toast("Nothing to rewind");
    return;
  }
  // rewinding to a message of yours removes it too and returns it to the composer
  const isUser = t.classList.contains("msg-user");
  const keep = isUser ? at : at + 1;
  if (isUser) {
    const input = t.closest(".screen").querySelector(".msg-input");
    if (input) {
      input.value = t.textContent.trim();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const c = conversationOf(route);
  const fixtures = entries.filter((e) => !e.matches("[data-sent]")).length;
  if (keep <= fixtures) {
    c.keptFixtures = keep;
    c.sent = [];
  } else c.sent = c.sent.slice(0, keep - fixtures);
  allScreens()
    .filter((o) => o.route === route)
    .forEach((o) => {
      const tr = o.el.querySelector(".transcript");
      if (tr)
        conversationEntries(tr)
          .slice(keep)
          .forEach((e) => e.remove());
    });
  toast("Rewound");
}

/* ---------- message actions ---------- */

const MSG_ACTIONS = [
  { label: "Copy", icon: "copy" },
  { label: "Fork from here", icon: "git-fork" },
  { label: "Rewind to here", icon: "history" },
  { label: "Share", icon: "share" },
];

function openMessageMenu(x, y, target) {
  msgTargetEl = target;
  closeMenus();
  menuRoot.innerHTML = `<div class="menu-backdrop" data-close-menu></div><div class="menu ctxmenu" id="ctxmenu"></div>`;
  const menu = $("#ctxmenu", menuRoot);
  // A thread whose computer is offline is read-only: nothing in it can be
  // rewound, as its composer cannot send.
  const readOnly = routeStale(screenOf(target).route);
  menu.innerHTML = MSG_ACTIONS.filter((it) => !(readOnly && it.label === "Rewind to here"))
    .map((it) => `<button data-msgact="${it.label}">${I(it.icon)}<span>${it.label}</span></button>`)
    .join("");
  placeMenu(menu, x, y);
  $$("button", menu).forEach((b) =>
    b.addEventListener("click", () => {
      const label = b.dataset.msgact;
      closeMenus();
      if (label === "Copy") toast("Copied to clipboard");
      else if (label === "Fork from here") toast("Forked — new thread created");
      else if (label === "Share") toast("Share sheet opened");
      else if (label === "Rewind to here") openSheetEl("rewind");
    }),
  );
}

/* ---------- menus ---------- */

const menuRoot = $("#menu-root");

const filterMenu = (key, labels) => () =>
  [FILTER_ALL[key], ...labels].map((label) => ({
    label,
    on: (threadFilter[key] || FILTER_ALL[key]) === label,
    run: () => {
      threadFilter[key] = label === FILTER_ALL[key] ? null : label;
      refreshData();
    },
  }));

const MENUS = {
  split: splitMenu,
  computers: filterMenu(
    "computers",
    Object.values(COMPUTERS).map((c) => c.name),
  ),
  projects: filterMenu("projects", PROJECTS),
  modes: filterMenu(
    "modes",
    Object.values(MODES).map((m) => m.label),
  ),
  arrange: [
    { label: "Status", icon: "circle-dot" },
    { label: "Projects", icon: "folder" },
    { label: "Activity", icon: "history" },
  ],
  prcomputers: [{ label: "All computers", on: true }, { label: "Studio Mac" }, { label: "Devbox" }],
  prrepos: [
    { label: "All repositories", on: true },
    { label: "Ogard-Labs/octant" },
    { label: "Ogard-Labs/octant-site" },
  ],
  prsort: [
    { label: "Newest first", on: true },
    { label: "Oldest first" },
    { label: "Most discussed" },
  ],
  prrepo: [
    { label: "Open on GitHub", icon: "external-link" },
    { label: "Copy clone URL", icon: "copy" },
    { sep: true },
    { label: "Hide repository", icon: "eye-off", danger: true },
  ],
  threadmore: () => {
    const stale = currentThreadStale();
    return [
      { label: `Mode: ${modeState}`, icon: "sliders-horizontal", sub: "mode" },
      { label: "Pin thread", icon: "pin" },
      { label: "Rename", icon: "pencil" },
      ...restItems(currentThread()),
      { sep: true },
      { label: "Archive", icon: "archive", danger: true, disabled: stale },
      { label: "Delete", icon: "trash-2", danger: true, disabled: stale },
    ];
  },
  mode: () => MODE_OPTIONS.map((m) => ({ label: m, on: m === modeState })),
  settheme: () => ["System", "Light", "Dark"].map((l) => ({ label: l, on: themeLabel() === l })),
  setbg: [
    { label: "Off", on: true },
    { label: "Octant canvas" },
    { label: "Atmosphere photo" },
    { label: "Your photo" },
  ],
  botmore: [
    { label: "Edit role", icon: "pencil" },
    { label: "Sleep schedule", icon: "alarm-clock" },
    { sep: true },
    { label: "Delete bot", icon: "trash-2", danger: true },
  ],
  prmore: [
    { label: "Copy link", icon: "copy" },
    { label: "Subscribe", icon: "bell" },
    { sep: true },
    { label: "Close pull request", icon: "circle-x", danger: true },
  ],
  prmore2: [
    { label: "Start a Code thread", icon: "square-code" },
    { label: "Request reviewer", icon: "user-plus" },
    { sep: true },
    { label: "Close pull request", icon: "circle-x", danger: true },
  ],
  review: [
    { label: "Approve", icon: "check" },
    { label: "Request changes", icon: "message-square" },
    { sep: true },
    { label: "Comment only", icon: "message-circle" },
  ],
  mergeinfo: [
    { label: "Merge pull request", icon: "git-merge", on: true },
    { label: "Squash and merge", icon: "git-commit-horizontal" },
    { label: "Rebase and merge", icon: "git-fork" },
  ],
  models: [
    { label: "Opus · High", on: true },
    { label: "Opus · Medium" },
    { label: "Sonnet · High" },
    { label: "Haiku · Low" },
  ],
  sheetcomputer: [{ label: "Studio Mac", on: true }, { label: "Devbox" }],
  sheetproject: [{ label: "octant", on: true }, { label: "octant-site" }],
  sheetmodel: [
    { label: "Opus · High", on: true },
    { label: "Sonnet · High" },
    { label: "Haiku · Low" },
  ],
};

/* Keep a menu inside the frame, and on one side of a hinge. */
function placeMenu(menu, x, y, { alignRight = false, flipTop = null } = {}) {
  menuRoot.classList.add("open");
  const frame = phone.getBoundingClientRect();
  const safe = updateSafeArea();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = x - frame.left - (alignRight ? w : 0);
  let top = y - frame.top;
  left = Math.max(safe.left + 8, Math.min(left, safe.right - w - 8));
  if (top + h > frame.height - 16 && flipTop !== null) top = flipTop - frame.top - h;
  top = Math.max(60, Math.min(top, frame.height - h - 16));
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function currentThread() {
  return threadById(parseRoute(topScreen().route).arg);
}

/* Settle and Snooze with the reason where the host would refuse them. */
function restItems(t) {
  const item = (label, icon, action) => {
    const refused = restRefusal(t, action);
    const undo = action === "unsettle" || action === "wake";
    const reason = undo && isConnected(t) ? null : refused;
    return { label, icon, disabled: !!reason, reason, run: () => setRest(t, action) };
  };
  return [
    t.snoozed ? item("Wake", "moon", "wake") : item("Snooze", "moon", "snooze"),
    t.settled ? item("Un-settle", "history", "unsettle") : item("Settle", "check", "settle"),
  ];
}

function currentThreadStale() {
  const t = topScreen();
  return t ? routeStale(t.route) : false;
}

/** Whether the thread a screen shows is on a computer that is offline. */
function routeStale(route) {
  if (parseRoute(route).name !== "thread") return false;
  const th = threadById(parseRoute(route).arg);
  return th && COMPUTERS[th.computer].status === "stale";
}

function openMenu(key, anchorEl) {
  closeMenus();
  let items = MENUS[key];
  if (typeof items === "function") items = items(anchorEl);
  if (!items) return;
  menuRoot.innerHTML = `<div class="menu-backdrop" data-close-menu></div><div class="menu" id="menu"></div>`;
  const menu = $("#menu", menuRoot);
  menu.innerHTML = items
    .map((it) =>
      it.sep
        ? `<div class="msep"></div>`
        : it.head
          ? `<div class="mhead">${esc(it.head)}</div>`
          : `<button class="${it.danger ? "mdanger" : ""}${it.disabled ? " mdisabled" : ""}" data-mlabel="${esc(it.label)}" ${it.sub ? `data-msub="${it.sub}"` : ""}>
        ${it.icon ? I(it.icon) : ""}<span>${esc(it.label)}</span>
        ${it.on ? `<span style="margin-left:auto;color:var(--accent)">${I("check", "s14")}</span>` : ""}
        ${it.sub ? `<span style="margin-left:auto;color:var(--text-muted)">${I("chevron-right", "s13")}</span>` : ""}
      </button>`,
    )
    .join("");
  const r = anchorEl.getBoundingClientRect();
  placeMenu(menu, r.right, r.bottom + 6, { alignRight: true, flipTop: r.top - 8 });
  $$("button", menu).forEach((b) =>
    b.addEventListener("click", () => {
      const label = b.dataset.mlabel;
      const sub = b.dataset.msub;
      const item = items.find((it) => it.label === label);
      closeMenus();
      if (item.disabled) {
        toast(item.reason || `${currentThreadComputer()} is offline`);
        return;
      }
      if (item.run) {
        item.run();
        return;
      }
      if (sub === "mode") {
        openMenu("mode", anchorEl);
        return;
      }
      onMenuPick(key, label, anchorEl);
    }),
  );
}

function currentThreadComputer() {
  const t = topScreen();
  if (!t) return "Devbox";
  const th = threadById(parseRoute(t.route).arg || "");
  return th ? COMPUTERS[th.computer].name : "Devbox";
}

function closeMenus() {
  menuRoot.classList.remove("open");
  menuRoot.innerHTML = "";
}

function relabel(anchor, label) {
  const target = anchor.classList.contains("formrow") ? anchor.querySelector(".fval") : anchor;
  if (!target) return;
  for (const n of target.childNodes) {
    if (n.nodeType === 3 && n.textContent.trim()) n.textContent = " " + label + " ";
  }
}

const SELECT_KEYS = [
  "prcomputers",
  "prrepos",
  "prsort",
  "models",
  "sheetcomputer",
  "sheetproject",
  "sheetmodel",
];

function onMenuPick(key, label, anchor) {
  if (SELECT_KEYS.includes(key)) relabel(anchor, label);
  if (key === "arrange") toast(`Sorted by ${label.toLowerCase()}`);
  if (key === "review")
    toast(
      label === "Approve"
        ? "Review submitted: approved"
        : label === "Request changes"
          ? "Changes requested"
          : "Comment draft opened",
    );
  if (key === "mergeinfo") toast(`Will ${label.toLowerCase()}`);
  if (key === "prmore2" && label === "Start a Code thread") toast("Opening a Code thread…");
  if (key === "prrepo" || key === "prmore") toast(label);
  if (key === "botmore") toast(label);
  if (key === "threadmore") {
    if (label === "Pin thread") toast("Thread pinned");
    else if (label === "Archive") toast("Thread archived");
    else if (label === "Delete") toast("Thread deleted");
    else if (label === "Rename") toast("Rename — double-tap the title in a real build");
  }
  if (key === "newbot") toast("Bot created");
  if (key === "settheme") {
    const map = { System: "system", Light: "light", Dark: "dark" };
    if (map[label]) setThemePref(map[label]);
    return;
  }
  if (key === "setbg") {
    toast(`Background: ${label.toLowerCase()}`);
    return;
  }
  if (key === "mode") {
    if (label === "Full access") {
      openAlert({
        title: "Full access",
        msg: "Full access lets agents run commands and change files without asking. Use it only on a computer and Project you trust.",
        actions: [
          { label: "Cancel", tone: "plain" },
          {
            label: "Use Full access",
            tone: "danger",
            fn: () => {
              modeState = "Full access";
              toast("Mode: Full access");
            },
          },
        ],
      });
      return;
    }
    modeState = label;
    toast(`Mode: ${label}`);
  }
}

/* ---------- alert ---------- */

const alertRoot = $("#alert-root");
function openAlert({ title, msg, actions }) {
  closeAlert();
  alertRoot.innerHTML = `
    <div class="alert-backdrop" data-alert-close>
      <div class="alert-box" role="alertdialog">
        ${title ? `<div class="al-title">${esc(title)}</div>` : ""}
        <div class="al-msg">${esc(msg)}</div>
        <div class="al-btns">
          ${actions.map((a, i) => `<button class="al-btn ${a.tone === "danger" ? "danger" : ""}" data-alert-act="${i}">${esc(a.label)}</button>`).join("")}
        </div>
      </div>
    </div>`;
  alertRoot.classList.add("open");
  alertRoot._actions = actions;
  $$("[data-alert-act]", alertRoot).forEach((b) =>
    b.addEventListener("click", () => {
      const a = alertRoot._actions[+b.dataset.alertAct];
      closeAlert();
      a.fn && a.fn();
    }),
  );
}
function closeAlert() {
  alertRoot.classList.remove("open");
  alertRoot.innerHTML = "";
  alertRoot._actions = null;
}
alertRoot.addEventListener("click", (e) => {
  if (e.target.dataset.alertClose !== undefined) closeAlert();
});

/* ---------- toast ---------- */

let toastEl = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText = `
      position:absolute;left:calc(var(--safe-l, 0px) + var(--safe-w, 100%) / 2);bottom:96px;transform:translateX(-50%);
      max-width:calc(var(--safe-w, 100%) - 32px);text-align:center;
      background:var(--floating);color:var(--text-primary);
      border:1px solid var(--border-strong);border-radius:12px;
      padding:9px 16px;font-size:13.5px;font-weight:500;z-index:120;
      box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:none;
      opacity:0;transition:opacity .2s ease;`;
    toastEl.setAttribute("role", "status");
    phone.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  updateSafeArea();
  requestAnimationFrame(() => (toastEl.style.opacity = "1"));
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.style.opacity = "0"), 1800);
}

/* ---------- context menu (long press) ---------- */

function openContextMenu(x, y, tid, from) {
  closeMenus();
  menuRoot.innerHTML = `<div class="menu-backdrop" data-close-menu></div><div class="menu ctxmenu" id="ctxmenu"></div>`;
  const menu = $("#ctxmenu", menuRoot);
  const t = threadById(tid);
  const items = [
    {
      label: t.pinned ? "Unpin" : "Pin",
      icon: "pin",
      run: () => {
        t.pinned = !t.pinned;
        toast(t.pinned ? "Thread pinned" : "Thread unpinned");
        refreshData();
      },
    },
    ...restItems(t),
    { label: "Rename", icon: "pencil" },
  ];
  menu.innerHTML = items
    .map(
      (it) =>
        `<button class="${it.disabled ? "mdisabled" : ""}" data-ctx="${it.label}">${I(it.icon)}<span>${it.label}</span></button>`,
    )
    .join("");
  placeMenu(menu, x, y);
  $$("button", menu).forEach((b) =>
    b.addEventListener("click", () => {
      const label = b.dataset.ctx;
      const item = items.find((it) => it.label === label);
      closeMenus();
      if (item.disabled) {
        toast(item.reason);
        return;
      }
      if (item.run) {
        item.run();
        return;
      }
      const row = from.querySelector(".trow");
      if (!row || !row.isConnected) return;
      if (label === "Rename") {
        const t1 = row.querySelector(".t1");
        const input = document.createElement("input");
        input.className = "rename-input";
        input.value = t.title;
        t1.replaceWith(input);
        input.focus();
        input.select();
        const done = () => {
          t.title = input.value.trim() || t.title;
          input.replaceWith(t1);
          refreshData();
        };
        input.addEventListener("blur", done, { once: true });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") input.blur();
          if (e.key === "Escape") {
            input.value = "";
            input.blur();
          }
        });
      }
    }),
  );
}

/* ============================== global events ============================== */

let pressTimer = null;
let pressFired = false;
let swipe = null;
let suppressClick = false;

phone.addEventListener("pointerdown", (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  pressFired = false;
  suppressClick = false;
  const trow = e.target.closest(".trow");
  const wrap = e.target.closest(".rowwrap");
  lastTouchX = e.clientX - phone.getBoundingClientRect().left;
  const inPane = e.target.closest(".pane");
  const pane = inPane ? paneOf(inPane) : null;
  const onEdge = pane && e.clientX - inPane.getBoundingClientRect().left < 26;

  if (onEdge && pane.stack.length > 1 && !trow) {
    swipe = {
      kind: "edge",
      pane,
      x: e.clientX,
      y: e.clientY,
      active: false,
      topEl: topOf(pane).el,
      underEl: pane.stack[pane.stack.length - 2].el,
    };
  } else if (trow && wrap && !e.target.closest("button,a,input,textarea")) {
    pressTimer = setTimeout(() => {
      pressFired = true;
      const r = wrap.getBoundingClientRect();
      openContextMenu(r.left + 40, r.top + r.height / 2, wrap.dataset.tid, wrap);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 480);
    swipe = { kind: "row", row: wrap, x: e.clientX, y: e.clientY, mode: null };
  } else {
    const msgT = e.target.closest(".msg-user,.md");
    const onThread = e.target.closest('[data-route^="thread/"]');
    if (msgT && onThread && !e.target.closest("button,a,input,textarea,pre")) {
      pressTimer = setTimeout(() => {
        pressFired = true;
        const r = msgT.getBoundingClientRect();
        openMessageMenu(r.left + r.width / 2, r.top + 10, msgT);
        if (navigator.vibrate) navigator.vibrate(10);
      }, 480);
    }
    swipe = null;
  }
});

phone.addEventListener("pointermove", (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (pressTimer && Math.abs(dy) > 10) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }

  if (swipe.kind === "edge") {
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) swipe.active = true;
    if (swipe.active && dx > 0 && swipe.topEl) {
      const w = swipe.pane.el.getBoundingClientRect().width;
      const t = Math.min(dx / w, 1);
      swipe.topEl.style.transition = "none";
      swipe.topEl.style.transform = `translateX(${t * 100}%)`;
      if (swipe.underEl) {
        swipe.underEl.style.transition = "none";
        swipe.underEl.style.transform = `translateX(${-18 * (1 - t)}%)`;
      }
    }
  } else if (swipe.kind === "row") {
    if (swipe.mode === null) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        swipe.mode = "h";
        clearTimeout(pressTimer);
        pressTimer = null;
      } else if (Math.abs(dy) > 12) {
        swipe.mode = "v";
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    }
    if (swipe.mode === "h") {
      swipe.row.classList.add("dragging");
      const nx = Math.min(0, Math.max(dx, -150));
      const trow = swipe.row.querySelector(".trow");
      trow.style.transition = "none";
      trow.style.transform = `translateX(${nx}px)`;
      swipe.row._nx = nx;
    }
  }
});

function endPointer(e) {
  if (swipe) {
    if (swipe.kind === "edge" && swipe.topEl) {
      const w = swipe.pane.el.getBoundingClientRect().width;
      const pane = swipe.pane;
      const dx = e.clientX - swipe.x;
      const el = swipe.topEl;
      const under = swipe.underEl;
      el.style.transition = "";
      if (under) under.style.transition = "";
      if (swipe.active && dx > Math.max(80, w * 0.25)) {
        el.style.transform = "translateX(102%)";
        if (under) under.style.transform = "";
        suppressClick = true;
        setTimeout(() => goBack(pane), 30);
      } else {
        el.style.transform = "";
        if (under) under.style.transform = "";
        if (swipe.active) suppressClick = true;
      }
    } else if (swipe.kind === "row") {
      const row = swipe.row;
      const trow = row.querySelector(".trow");
      trow.style.transition = "";
      if (swipe.mode === "h") {
        const nx = row._nx || 0;
        if (nx < -70) row.classList.add("swiped");
        else row.classList.remove("swiped");
        trow.style.transform = "";
        suppressClick = true;
        setTimeout(() => row.classList.remove("dragging"), 220);
      } else {
        trow.style.transform = "";
      }
    }
    swipe = null;
  }
  clearTimeout(pressTimer);
  pressTimer = null;
}
phone.addEventListener("pointerup", endPointer);
phone.addEventListener("pointercancel", endPointer);
phone.addEventListener("contextmenu", (e) => {
  if (e.target.closest(".trow")) e.preventDefault();
});

// suppress click after long-press or swipe; otherwise the pane pressed is selected
phone.addEventListener(
  "click",
  (e) => {
    if (pressFired || suppressClick) {
      pressFired = false;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (e.target.closest(".pane")) focusPane(paneOf(e.target));
  },
  true,
);
phone.addEventListener("focusin", (e) => {
  if (e.target.closest(".pane") && e.target.matches("input, textarea")) focusPane(paneOf(e.target));
  setTimeout(syncKeyboard, 0);
});
phone.addEventListener("focusout", () => setTimeout(syncKeyboard, 0));
// pressing a composer button keeps the keyboard up
phone.addEventListener("mousedown", (e) => {
  if (e.target.closest(".composer button")) e.preventDefault();
});
phone.addEventListener("keydown", (e) => {
  // rows that open something act like buttons from the keyboard
  const row = e.target.closest?.('.row[role="button"], [data-open][role="button"]');
  if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    row.click();
  }
  if (e.key === "Enter" && e.target.matches?.(".msg-input"))
    e.target.closest(".screen").querySelector(".sendbtn")?.click();
});

// long-press tooltip on tab bar icons
let tipTimer = null;
let tipEl = null;
tabbarEl.addEventListener("pointerdown", (e) => {
  const b = e.target.closest(".tabbtn");
  if (!b) return;
  tipTimer = setTimeout(() => {
    tipEl = document.createElement("div");
    tipEl.className = "tabtip";
    tipEl.textContent = b.getAttribute("aria-label") || "";
    const pr = phone.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    tipEl.style.left = r.left - pr.left + r.width / 2 + "px";
    tipEl.style.bottom = "78px";
    phone.appendChild(tipEl);
  }, 550);
});
["pointerup", "pointermove", "pointercancel"].forEach((ev) =>
  tabbarEl.addEventListener(ev, () => {
    clearTimeout(tipTimer);
    if (tipEl) {
      tipEl.remove();
      tipEl = null;
    }
  }),
);

/* ---------- delegated clicks ---------- */

phone.addEventListener("click", (e) => {
  if (pressFired) return;
  const el = e.target;

  // tab bar
  const tab = el.closest("[data-tab]");
  if (tab) {
    hideDevicePage();
    openPlace(tab.dataset.tab);
    return;
  }
  if (el.closest("[data-new]")) {
    openSheetEl("new");
    return;
  }
  if (el.closest("[data-new-bot]")) {
    toast("Describe the bot and Octant will draft its role");
    return;
  }

  // back
  const back = el.closest("[data-back]");
  if (back) {
    goBack(paneOf(back));
    return;
  }

  // Home counts
  const count = el.closest("[data-count]");
  if (count) {
    openCount("list/" + count.dataset.count, count);
    return;
  }

  // settled banner and question card
  const un0 = el.closest("[data-unsettle]");
  if (un0) {
    setRest(threadById(un0.dataset.unsettle), "unsettle");
    return;
  }
  const answer = el.closest("[data-answer]");
  if (answer) {
    answerAsk(threadById(answer.dataset.answer));
    return;
  }

  // dead buttons get a subtle toast
  const dead = el.closest("[data-dead]");
  if (dead) {
    toast(dead.dataset.dead);
    return;
  }

  // menus
  const menuBtn = el.closest("[data-menu]");
  if (menuBtn) {
    openMenu(menuBtn.dataset.menu, menuBtn);
    return;
  }

  // thread rows (only inside .rowwrap; bot rows reuse .trow styling)
  const trow = el.closest(".trow");
  const wrap0 = trow ? trow.closest(".rowwrap") : null;
  if (trow && wrap0 && !el.closest(".rowactions")) {
    const wrap = wrap0;
    if (wrap.classList.contains("swiped")) {
      wrap.classList.remove("swiped");
      return;
    }
    const tid = trow.dataset.tid || wrap.dataset.tid;
    const t = THREADS.find((x) => x.id === tid);
    if (t) openRow("thread/" + t.id, wrap);
    return;
  }

  // row actions
  const act = el.closest(".rowactions button");
  if (act) {
    const wrap = act.closest(".rowwrap");
    wrap.classList.remove("swiped");
    setRest(threadById(wrap.dataset.tid), act.dataset.act);
    return;
  }

  // bots rows
  const botrow = el.closest("[data-bot]");
  if (botrow) {
    openRow("bot/" + botrow.dataset.bot, botrow);
    return;
  }

  // PR rows
  const prrow = el.closest("[data-pr]");
  if (prrow) {
    openRow("pr/2864", prrow);
    return;
  }

  // section headers
  const sechead = el.closest(".sechead");
  if (sechead) {
    const sec = sechead.closest(".section");
    const key = sechead.dataset.sec;
    if (collapsedSections.has(key)) collapsedSections.delete(key);
    else collapsedSections.add(key);
    sec.classList.toggle("collapsed");
    sechead.classList.toggle("collapsed");
    const chev = sechead.querySelector(".chev");
    chev.classList.toggle("open", !sec.classList.contains("collapsed"));
    return;
  }

  // PR segments
  const seg = el.closest(".segbar button");
  if (seg) {
    const screen = seg.closest(".screen");
    $$(".segbar button", screen).forEach((b) => b.classList.toggle("on", b === seg));
    $$(".prbody", screen).forEach((b, i) => {
      b.style.display = i === +seg.dataset.seg ? "" : "none";
    });
    return;
  }

  // file cards
  const filehead = el.closest(".filehead");
  if (filehead) {
    filehead.closest(".filecard").classList.toggle("open");
    return;
  }

  // tool run
  const run = el.closest(".toolrun > .thead");
  if (run) {
    run.parentElement.classList.toggle("open");
    return;
  }

  // approval buttons
  const appr = el.closest("[data-approve]");
  if (appr) {
    answerAsk(threadById(appr.dataset.tid));
    toast(
      { once: "Allowed once", always: "Always allowed in this Project", deny: "Denied" }[
        appr.dataset.approve
      ],
    );
    return;
  }

  // inbox chips
  const ichip = el.closest("[data-ick]");
  if (ichip) {
    inboxFilter = ichip.dataset.ick;
    refreshData();
    return;
  }

  // inbox allow/deny
  const inb = el.closest("[data-inbox]");
  if (inb) {
    answerAsk(threadById(inb.dataset.tid));
    toast(inb.dataset.inbox === "allow" ? "Allowed" : "Denied");
    return;
  }

  // inbox rows open their thread
  const openEl = el.closest("[data-open]");
  if (openEl && !el.closest("button")) {
    openRow(openEl.dataset.open, openEl);
    return;
  }

  // needs-my-review chip
  if (el.closest("[data-needs-review]")) {
    el.closest("[data-needs-review]").classList.toggle("on");
    toast("Showing pull requests that need your review");
    return;
  }

  // send button
  if (el.closest(".sendbtn")) {
    const s = screenOf(el);
    const input = s.el.querySelector(".msg-input");
    const text = input.value.trim();
    if (text) {
      addUserMessage(s.route, text);
      for (const o of allScreens().filter((o) => o.route === s.route)) {
        o.el.querySelector(".msg-input").value = "";
        syncSend(o.el);
      }
      textDrafts.delete(s.route);
      getDrafts(s.route).length = 0;
      refreshComposerChips(s.route);
      // a message starts a turn, and brings a settled or snoozed thread back
      const t = threadById(parseRoute(s.route).arg);
      Object.assign(t, { settled: false, snoozed: false, elapsed: "now" });
      if (t.status !== "waiting") t.status = "working";
      refreshData();
    }
    return;
  }

  // remove attachment chip (scoped to the current screen's draft)
  const un = el.closest("[data-unattach]");
  if (un) {
    const s = screenOf(un);
    getDrafts(s.route).splice(+un.dataset.unattach, 1);
    refreshComposerChips(s.route);
    return;
  }

  // sheets (panes, model, pair, rewind)
  const sheetBtn = el.closest("[data-sheet]");
  if (sheetBtn) {
    const kind = sheetBtn.dataset.sheet;
    if (kind === "panes" && deviceMode === "ipad") {
      relayout(() => {
        ipadInspector = !ipadInspector;
      });
      return;
    }
    openSheetEl(kind);
    return;
  }

  // pushes (settings rows, iPad sidebar)
  const pushEl = el.closest("[data-push]");
  if (pushEl) {
    recordHash(pushEl.dataset.push);
    openIn(paneOf(pushEl), pushEl.dataset.push);
    return;
  }

  // iPad sidebar
  const sideOpen = el.closest("[data-side-open]");
  if (sideOpen) {
    openSide(sideOpen.dataset.sideOpen);
    return;
  }
  const sidePush = el.closest("[data-side-push]");
  if (sidePush) {
    openIn(barPane(), sidePush.dataset.sidePush);
    return;
  }

  // panes shown beside a thread (iPad inspector, dual screen)
  const host = el.closest(".panes-host");
  if (host) {
    const segBtn = el.closest("[data-panes-seg]");
    const fileBtn = el.closest("[data-panes-file]");
    if (segBtn)
      Object.assign(panesState, { seg: +segBtn.dataset.panesSeg, view: "root", file: null });
    else if (fileBtn)
      Object.assign(panesState, { file: PANES_FILES[+fileBtn.dataset.panesFile], view: "diff" });
    else if (el.closest("[data-panes='review']"))
      Object.assign(panesState, { seg: 1, view: "root" });
    else if (el.closest("[data-panes='back']"))
      Object.assign(panesState, { view: "root", file: null });
    else return;
    refreshPanesHosts();
    return;
  }

  // lock screen stale toggle
  if (el.closest("#la-stale")) {
    const card = $("#la-card");
    card?.classList.toggle("stale");
    return;
  }
});

/* native settings switches */
phone.addEventListener("change", (e) => {
  const sw = e.target.closest("input.set-switch[data-set]");
  if (!sw) return;
  const key = sw.dataset.set;
  if (key === "names") {
    showNames = sw.checked;
    localStorage.setItem("octant-mock-names", showNames ? "1" : "0");
    syncNamesUI();
    refreshAwareness();
    toast(showNames ? "Thread names shown" : "Thread names hidden");
    return;
  }
  demoPrefs[key] = sw.checked;
  toast(sw.checked ? "Turned on" : "Turned off");
});

function syncNamesUI() {
  $$("input.set-switch[data-set='names']").forEach((s) => {
    s.checked = showNames;
  });
  const nc = $("#names-toggle");
  if (nc) nc.checked = showNames;
}
function refreshAwareness() {
  if (deviceRoute) showDevicePage(deviceRoute);
}

function addUserMessage(route, text) {
  conversationOf(route).sent.push(text);
  allScreens()
    .filter((o) => o.route === route)
    .forEach((o) => {
      const transcript = o.el.querySelector(".transcript");
      transcript.insertBefore(sentMessageEl(text), transcript.querySelector(".t-live"));
      const sc = o.el.querySelector(".scroll");
      sc.scrollTop = sc.scrollHeight;
    });
}

/* ---------- input listeners (delegated) ---------- */

phone.addEventListener("input", (e) => {
  if (!e.target.matches(".composer input")) return;
  const s = screenOf(e.target);
  textDrafts.set(s.route, e.target.value);
  syncSend(s.el);
  allScreens()
    .filter((o) => o !== s && o.route === s.route)
    .forEach((o) => {
      o.el.querySelector(".composer input").value = e.target.value;
      syncSend(o.el);
    });
});

/* ---------- sheet backdrop / menu backdrop clicks ---------- */

sheetRoot.addEventListener("click", (e) => {
  if (e.target.dataset.closeSheet !== undefined || e.target.classList.contains("sheet-backdrop"))
    closeSheet();
});
menuRoot.addEventListener("click", (e) => {
  if (e.target.classList.contains("menu-backdrop")) closeMenus();
});

/* ---------- control panel ---------- */

const themeBtns = $$(".seg-light button");
function setThemePref(p) {
  themePref = p === "system" ? "system" : p;
  const eff =
    themePref === "system"
      ? window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : themePref;
  phone.dataset.theme = eff;
  localStorage.setItem("octant-mock-theme", eff);
  localStorage.setItem("octant-mock-theme-pref", themePref);
  themeBtns.forEach((b) => b.classList.toggle("on", b.dataset.theme === eff));
  for (const tv of $$('[data-menu="settheme"] .set-val')) tv.textContent = themeLabel();
}
function setTheme(t) {
  setThemePref(t);
}
themeBtns.forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.theme)));

const beforeCheck = $("#before-toggle");
beforeCheck.checked = beforeMode;
beforeCheck.addEventListener("change", () => {
  beforeMode = beforeCheck.checked;
  localStorage.setItem("octant-mock-before", beforeMode ? "1" : "0");
  const keys = visibleTabs().map((t) => t.key);
  panes.forEach((p) => {
    const hidden = p.stack.some(
      (s) =>
        (isTab(s.route) && !keys.includes(s.route)) ||
        (parseRoute(s.route).name === "bot" && beforeMode),
    );
    if (hidden) {
      clearPane(p);
      pushScreen(p, "home", { instant: true });
    }
  });
  layoutPanes();
  syncHash();
});

const emptyCheck = $("#empty-toggle");
emptyCheck.addEventListener("change", () => {
  emptyCounts = emptyCheck.checked;
  refreshData();
});
const keyboardCheck = $("#keyboard-toggle");
keyboardCheck.addEventListener("change", () => {
  keyboardOn = keyboardCheck.checked;
  syncKeyboard();
});

$("#share-btn").addEventListener("click", () => openSheetEl("send"));

/* device toggles */
const namesCheck = $("#names-toggle");
namesCheck.checked = showNames;
namesCheck.addEventListener("change", () => {
  showNames = namesCheck.checked;
  localStorage.setItem("octant-mock-names", showNames ? "1" : "0");
  syncNamesUI();
  refreshAwareness();
});

const devSelect = $("#device-select");
const postSelect = $("#posture-select");
function syncDeviceUI() {
  devSelect.value = deviceMode;
  const opts = POSTURES[deviceMode];
  postSelect.style.display = opts ? "" : "none";
  if (opts) {
    postSelect.innerHTML = opts
      .map(([v, l]) => `<option value="${v}"${v === posture ? " selected" : ""}>${l}</option>`)
      .join("");
  }
  updateDeviceNote();
}
devSelect.addEventListener("change", () => setDeviceMode(devSelect.value));
postSelect.addEventListener("change", () => setPosture(postSelect.value));
function updateDeviceNote() {
  const note = $("#device-note");
  if (!note) return;
  note.textContent =
    deviceMode === "android" || deviceMode === "androidfold"
      ? "Android preview: Material chrome; non-core screens may keep iOS styling. Frame sizes are illustrative."
      : deviceMode === "ipad"
        ? "iPad layout: sidebar, then one pane in full or two side by side."
        : deviceMode === "duo"
          ? "iPhone Duo preview: folded/unfolded are illustrative widths, not hardware metrics."
          : "";
}
phone.dataset.device = deviceMode;
phone.dataset.posture = POSTURES[deviceMode] ? posture : "";
syncDeviceUI();

/* ---------- boot ---------- */

(function init() {
  if (POSTURES[deviceMode] && !POSTURES[deviceMode].some(([k]) => k === posture))
    posture = POSTURES[deviceMode][0][0];
  phone.dataset.posture = POSTURES[deviceMode] ? posture : "";
  syncDeviceUI();
  // restore the choice, not what it resolved to, so System keeps following the OS
  setThemePref(themePref);
  const desired = parseRoute(location.hash).route;
  pushScreen(panes[0], "home", { instant: true });
  if (isDevicePage(desired)) showDevicePage(desired);
  else if (desired !== "home") openFrom(panes[0], desired);
  syncHash();
})();
