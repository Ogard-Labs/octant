/** The one first-party stylesheet the viewer loads: no font service, no import, no image. */
export const VIEWER_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1b1b1d;
  --muted: #5f5f66;
  --line: #d9d9de;
  --surface: #f5f5f7;
  --accent: #2f5fd0;
  --info: #e6eefc;
  --success: #e3f4ea;
  --warning: #fbf0dc;
  --danger: #fbe6e4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131315;
    --fg: #ececef;
    --muted: #a0a0a8;
    --line: #34343a;
    --surface: #1c1c1f;
    --accent: #7ea2f5;
    --info: #1f2a46;
    --success: #173024;
    --warning: #33270f;
    --danger: #3a1b19;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 1rem/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 52rem; margin: 0 auto; padding: 2rem 1rem 1rem; }
footer {
  max-width: 52rem;
  margin: 0 auto;
  padding: 1rem;
  color: var(--muted);
  font-size: 0.875rem;
  border-top: 1px solid var(--line);
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2rem 0 0.75rem; }
h1 { font-size: 2rem; margin-top: 0; }
a { color: var(--accent); }
.meta, .note { color: var(--muted); font-size: 0.875rem; }
.block { margin: 1rem 0; }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9375rem; }
caption { text-align: left; color: var(--muted); padding-bottom: 0.25rem; font-size: 0.875rem; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: var(--surface); }
pre, code { font: 0.875rem/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
pre { background: var(--surface); padding: 0.75rem 1rem; overflow-x: auto; border-radius: 6px; }
code { background: var(--surface); padding: 0.1rem 0.3rem; border-radius: 4px; }
pre code { background: none; padding: 0; }
.diff-add { color: #1f7a4d; }
.diff-remove { color: #b3261e; }
.diff-header { color: var(--muted); }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--line); }
blockquote footer { border: 0; padding: 0; margin: 0; font-size: 0.875rem; }
.callout { padding: 0.75rem 1rem; border-radius: 6px; border: 1px solid var(--line); background: var(--info); }
.callout.tone-success { background: var(--success); }
.callout.tone-warning { background: var(--warning); }
.callout.tone-danger { background: var(--danger); }
.callout-title { font-weight: 600; margin: 0 0 0.25rem; }
.metric dt { color: var(--muted); font-size: 0.875rem; }
.metric dd { margin: 0; font-size: 1.75rem; font-weight: 600; }
.status { padding: 0.05rem 0.5rem; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); font-size: 0.8125rem; }
.dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1.5rem; }
.pane { border-top: 1px solid var(--line); }
.tree { list-style: none; padding-left: 0; }
.depth-1 { padding-left: 1.25rem; }
.depth-2 { padding-left: 2.5rem; }
.depth-3 { padding-left: 3.75rem; }
.depth-4 { padding-left: 5rem; }
.depth-5 { padding-left: 6.25rem; }
.depth-6 { padding-left: 7.5rem; }
.depth-7 { padding-left: 8.75rem; }
.depth-8 { padding-left: 10rem; }
.image-placeholder { margin: 0; padding: 1rem; border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); }
.design-frame { display: block; max-width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.run-link { display: inline-block; padding: 0.4rem 0.9rem; border: 1px solid var(--accent); border-radius: 6px; text-decoration: none; }
.error { color: #b3261e; }
input, select, textarea, button { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
button { cursor: pointer; background: var(--surface); }
.report form { display: grid; gap: 0.5rem; max-width: 28rem; margin-top: 0.5rem; }
.report label { display: grid; gap: 0.25rem; }
`;
