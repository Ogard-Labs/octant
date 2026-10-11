/**
 * The frame kit: the first-party stylesheet a design drawn in the workspace
 * theme receives ahead of its own styles. It reads only the semantic tokens
 * the host writes into the frame, so a page built from these classes reads as
 * part of Octant in every theme and in forced colours. Authors may override
 * any rule; their stylesheet comes after this one. It uses tokens and system
 * colours only, never a colour of its own.
 */
export const DESIGN_FRAME_KIT = `
html {
  font-family: var(--oct-font-body);
  font-size: var(--oct-text-base);
  line-height: var(--oct-leading-body);
  color: var(--oct-fg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

a {
  color: var(--oct-accent-fg);
  text-decoration: underline;
  text-decoration-color: var(--oct-border);
  text-underline-offset: 0.2em;
}

::selection {
  background: var(--oct-selection);
}

/* ── article ── */

.oct-article {
  max-width: 72ch;
}

.oct-article > :first-child {
  margin-top: 0;
}

.oct-article > :last-child {
  margin-bottom: 0;
}

.oct-article h1,
.oct-article h2,
.oct-article h3,
.oct-article h4 {
  color: var(--oct-fg);
  font-weight: var(--oct-weight-strong);
  line-height: var(--oct-leading-heading);
  letter-spacing: var(--oct-tracking-snug);
  text-wrap: balance;
}

.oct-article h1 {
  margin: 0 0 var(--oct-space-3);
  font-size: var(--oct-text-3xl);
  letter-spacing: var(--oct-tracking-tight);
}

.oct-article h2 {
  margin: var(--oct-space-8) 0 var(--oct-space-3);
  font-size: var(--oct-text-xl);
}

.oct-article h3 {
  margin: var(--oct-space-6) 0 var(--oct-space-2);
  font-size: var(--oct-text-lg);
}

.oct-article h4 {
  margin: var(--oct-space-4) 0 var(--oct-space-2);
  font-size: var(--oct-text-base);
}

.oct-article p,
.oct-article ul,
.oct-article ol,
.oct-article blockquote,
.oct-article figure {
  margin: 0 0 var(--oct-space-4);
}

.oct-article ul,
.oct-article ol {
  padding-left: var(--oct-space-6);
}

.oct-article li + li {
  margin-top: var(--oct-space-1);
}

.oct-article blockquote {
  padding-left: var(--oct-space-4);
  border-left: 2px solid var(--oct-border);
  color: var(--oct-muted);
}

.oct-article hr {
  margin: var(--oct-space-8) 0;
  border: 0;
  border-top: 1px solid var(--oct-border);
}

.oct-article figcaption {
  margin-top: var(--oct-space-2);
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
}

.oct-eyebrow {
  margin: 0 0 var(--oct-space-2);
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
  font-weight: var(--oct-weight-medium);
  letter-spacing: var(--oct-tracking-wide);
  text-transform: uppercase;
}

.oct-lede {
  color: var(--oct-muted);
  font-size: var(--oct-text-lg);
  line-height: var(--oct-leading-snug);
}

.oct-muted {
  color: var(--oct-meta);
}

/* ── layout ── */

.oct-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--oct-space-3);
  margin: 0 0 var(--oct-space-4);
}

/* ── cards ── */

.oct-card {
  padding: var(--oct-space-4);
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-md);
  background: var(--oct-surface);
}

.oct-card > :first-child {
  margin-top: 0;
}

.oct-card > :last-child {
  margin-bottom: 0;
}

.oct-card__title {
  margin: 0 0 var(--oct-space-2);
  font-size: var(--oct-text-base);
  font-weight: var(--oct-weight-strong);
}

/* ── metric tiles ── */

.oct-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
  gap: var(--oct-space-3);
  margin: 0 0 var(--oct-space-6);
}

.oct-metric {
  display: grid;
  gap: var(--oct-space-1);
  padding: var(--oct-space-3) var(--oct-space-4);
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-md);
  background: var(--oct-surface);
}

.oct-metric__label {
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
}

.oct-metric__value {
  color: var(--oct-fg);
  font-size: var(--oct-text-2xl);
  font-weight: var(--oct-weight-strong);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--oct-tracking-tight);
  line-height: var(--oct-leading-tight);
}

.oct-metric__delta {
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
  font-variant-numeric: tabular-nums;
}

.oct-metric__delta--good {
  color: var(--oct-success-fg);
}

.oct-metric__delta--bad {
  color: var(--oct-danger-fg);
}

/* ── badges ── */

.oct-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--oct-space-1);
  padding: 1px var(--oct-space-2);
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-pill);
  background: var(--oct-fg-soft);
  color: var(--oct-fg-2);
  font-size: var(--oct-text-xs);
  font-weight: var(--oct-weight-medium);
  line-height: var(--oct-leading-snug);
  white-space: nowrap;
}

.oct-badge--accent {
  border-color: transparent;
  background: var(--oct-accent-soft);
  color: var(--oct-accent-fg);
}

.oct-badge--success {
  border-color: transparent;
  background: var(--oct-success-soft);
  color: var(--oct-success-fg);
}

.oct-badge--warn {
  border-color: transparent;
  background: var(--oct-warn-soft);
  color: var(--oct-warn-fg);
}

.oct-badge--danger {
  border-color: transparent;
  background: var(--oct-danger-soft);
  color: var(--oct-danger-fg);
}

/* ── callouts ── */

.oct-callout {
  margin: 0 0 var(--oct-space-4);
  padding: var(--oct-space-3) var(--oct-space-4);
  border: 1px solid var(--oct-border);
  border-left-width: 3px;
  border-radius: var(--oct-radius-sm);
  background: var(--oct-surface);
}

.oct-callout > :last-child {
  margin-bottom: 0;
}

.oct-callout__title {
  margin: 0 0 var(--oct-space-1);
  color: var(--oct-fg);
  font-weight: var(--oct-weight-strong);
}

.oct-callout--success {
  border-left-color: var(--oct-success-fg);
}

.oct-callout--warn {
  border-left-color: var(--oct-warn-fg);
}

.oct-callout--danger {
  border-left-color: var(--oct-danger-fg);
}

/* ── tables ── */

.oct-table-wrap {
  margin: 0 0 var(--oct-space-4);
  overflow-x: auto;
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-md);
}

.oct-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--oct-text-sm);
  font-variant-numeric: tabular-nums;
}

.oct-table th,
.oct-table td {
  padding: var(--oct-space-2) var(--oct-space-3);
  border-bottom: 1px solid var(--oct-border);
  text-align: left;
  vertical-align: top;
}

.oct-table th {
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
  font-weight: var(--oct-weight-medium);
  white-space: nowrap;
}

.oct-table tbody tr:last-child td {
  border-bottom: 0;
}

/* ── code ── */

code,
kbd,
pre {
  font-family: var(--oct-font-mono);
  font-size: 0.9em;
}

:not(pre) > code {
  padding: 0 0.3em;
  border-radius: 4px;
  background: var(--oct-fg-soft);
}

.oct-code {
  margin: 0 0 var(--oct-space-4);
  padding: var(--oct-space-3) var(--oct-space-4);
  overflow-x: auto;
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-sm);
  background: var(--oct-surface);
  line-height: var(--oct-leading-code);
  white-space: pre;
}

/* ── tabs ──
   Radio inputs and their labels, then one panel per tab in the same order.
   A checked radio shows the panel at its position, so the page switches tabs
   without running anything. Panels must be the block's only div children.
   CSS cannot pair the nth radio with the nth panel generically, so the kit
   pairs eight and the author instructions and DESIGN.md teach that limit. */

.oct-tabs {
  display: flex;
  flex-wrap: wrap;
  column-gap: var(--oct-space-4);
  margin: 0 0 var(--oct-space-4);
}

.oct-tabs > input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}

.oct-tabs > label {
  padding: var(--oct-space-2) 0;
  border-bottom: 2px solid transparent;
  color: var(--oct-meta);
  cursor: pointer;
  font-size: var(--oct-text-sm);
  font-weight: var(--oct-weight-medium);
}

.oct-tabs > label:hover {
  color: var(--oct-fg);
}

.oct-tabs > input:checked + label {
  border-bottom-color: var(--oct-fg);
  color: var(--oct-fg);
}

.oct-tabs > input:focus-visible + label {
  outline: 2px solid var(--oct-muted);
  outline-offset: 2px;
  border-radius: 2px;
}

.oct-tabs > .oct-tab-panel {
  display: none;
  flex-basis: 100%;
  margin-top: -1px;
  padding-top: var(--oct-space-4);
  border-top: 1px solid var(--oct-border);
}

.oct-tabs > .oct-tab-panel > :first-child {
  margin-top: 0;
}

.oct-tabs > input:nth-of-type(1):checked ~ .oct-tab-panel:nth-of-type(1),
.oct-tabs > input:nth-of-type(2):checked ~ .oct-tab-panel:nth-of-type(2),
.oct-tabs > input:nth-of-type(3):checked ~ .oct-tab-panel:nth-of-type(3),
.oct-tabs > input:nth-of-type(4):checked ~ .oct-tab-panel:nth-of-type(4),
.oct-tabs > input:nth-of-type(5):checked ~ .oct-tab-panel:nth-of-type(5),
.oct-tabs > input:nth-of-type(6):checked ~ .oct-tab-panel:nth-of-type(6),
.oct-tabs > input:nth-of-type(7):checked ~ .oct-tab-panel:nth-of-type(7),
.oct-tabs > input:nth-of-type(8):checked ~ .oct-tab-panel:nth-of-type(8) {
  display: block;
}

/* Forced colours replace every fill, so a tone keeps its meaning through its
   border and words, and the chosen tab through a system highlight. */
@media (forced-colors: active) {
  .oct-badge,
  .oct-badge--accent,
  .oct-badge--success,
  .oct-badge--warn,
  .oct-badge--danger {
    border-color: CanvasText;
  }

  .oct-tabs > label {
    border-bottom-color: Canvas;
  }

  .oct-tabs > input:checked + label {
    border-bottom-color: Highlight;
  }
}
`;
