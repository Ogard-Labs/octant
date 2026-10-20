import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasDesignBlock } from "@octant/contracts/canvas";

/**
 * The designs an agent is shown when it asks how to write one: a clickable
 * phone flow, a short deck, a spec drawn as a themed document, and a prototype
 * that runs. Wire shapes, not branded blocks: describe
 * returns these objects as-is.
 */
export const onboardingFlowExample = {
  blockId: "onboarding-flow",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "design" as const,
  title: "Onboarding",
  size: "phone" as const,
  styles: [
    "body { margin: 0; font-family: system-ui, sans-serif; color: #1c1917; background: #fafaf9; }",
    ".screen { min-height: 100vh; display: flex; flex-direction: column; padding: 32px 24px; box-sizing: border-box; gap: 16px; }",
    ".hero { height: 280px; border-radius: 24px; background: linear-gradient(160deg, #fdba74, #c2410c); }",
    "h1 { font-size: 28px; line-height: 1.15; margin: 0; }",
    "p { margin: 0; color: #57534e; }",
    ".button { display: block; padding: 16px; border-radius: 14px; background: #c2410c; color: white; text-align: center; text-decoration: none; font-weight: 600; }",
    ".quiet { color: #57534e; text-align: center; text-decoration: none; }",
    "input { padding: 14px; border-radius: 12px; border: 1px solid #d6d3d1; font: inherit; }",
  ].join("\n"),
  frames: [
    {
      frameId: "welcome",
      title: "Welcome",
      html: '<main class="screen"><div class="hero" role="img" aria-label="A bowl of noodles"></div><h1>Dinner from the places your street already loves.</h1><p>Local kitchens, delivered in about 30 minutes.</p><a class="button" href="#address">Get started</a><a class="quiet" href="#address">I already have an account</a></main>',
    },
    {
      frameId: "address",
      title: "Address",
      html: '<main class="screen"><a class="quiet" href="#welcome">Back</a><h1>Where should we deliver?</h1><input placeholder="Street address" aria-label="Street address"><a class="button" href="#welcome">Show restaurants</a></main>',
    },
  ],
};

/**
 * A deck laid out in fixed pixels at the slide size. A slide is drawn in a
 * 1920x1080 viewport and scaled as a picture, so `vh` and `vw` would track
 * whatever draws it rather than the slide; the type scale keeps body text at
 * 32px or above, and every slide carries the same header and footer.
 */
export const launchDeckExample = {
  blockId: "launch-deck",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "design" as const,
  title: "Launch plan",
  size: "slide" as const,
  styles: [
    "body { margin: 0; font-family: system-ui, sans-serif; background: #0c0a09; color: #fafaf9; }",
    ".slide { width: 1920px; height: 1080px; box-sizing: border-box; padding: 96px 160px; display: flex; flex-direction: column; }",
    ".eyebrow { font-size: 32px; color: #a8a29e; margin: 0; }",
    ".content { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 32px; }",
    "h1 { font-size: 96px; line-height: 1.1; margin: 0; }",
    "h2 { font-size: 64px; line-height: 1.15; margin: 0; }",
    "p, li { font-size: 40px; line-height: 1.5; margin: 0; }",
    "ul { margin: 0; padding-left: 48px; }",
    ".footer { display: flex; justify-content: space-between; font-size: 32px; color: #a8a29e; }",
  ].join("\n"),
  frames: [
    {
      frameId: "title",
      title: "Title",
      html: '<section class="slide"><p class="eyebrow">Spring release</p><div class="content"><h1>Launch plan</h1><p>Every region, half the wait.</p></div><footer class="footer"><span>Launch plan</span><span>1 / 2</span></footer></section>',
    },
    {
      frameId: "goals",
      title: "Goals",
      html: '<section class="slide"><p class="eyebrow">Spring release</p><div class="content"><h2>Goals</h2><ul><li>Ship to every region</li><li>Halve first-order time</li></ul></div><footer class="footer"><span>Launch plan</span><span>2 / 2</span></footer></section>',
    },
  ],
};

/**
 * A spec drawn as a document in the workspace theme: the frame kit's article
 * typography, CSS-only tabs, metric tiles, a badge table, a callout, and code.
 * It sets no colour or font of its own, so it reads as part of Octant in every
 * theme.
 */
export const searchSpecExample = {
  blockId: "search-spec",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "design" as const,
  title: "Search ranking spec",
  size: "document" as const,
  frames: [
    {
      frameId: "spec",
      title: "Spec",
      html: [
        '<article class="oct-article">',
        '<p class="oct-eyebrow">Spec · Draft</p>',
        "<h1>Search ranking</h1>",
        '<p class="oct-lede">Rank results by what the person did last, then by how well the title matches.</p>',
        '<div class="oct-metrics">',
        '<div class="oct-metric"><span class="oct-metric__label">Median latency</span><span class="oct-metric__value">84 ms</span><span class="oct-metric__delta oct-metric__delta--good">−12 ms</span></div>',
        '<div class="oct-metric"><span class="oct-metric__label">Click-through</span><span class="oct-metric__value">41%</span><span class="oct-metric__delta oct-metric__delta--good">+6 pts</span></div>',
        '<div class="oct-metric"><span class="oct-metric__label">Zero results</span><span class="oct-metric__value">3.2%</span><span class="oct-metric__delta oct-metric__delta--bad">+0.4 pts</span></div>',
        "</div>",
        '<div class="oct-tabs">',
        '<input type="radio" name="spec-tabs" id="spec-overview" checked><label for="spec-overview">Overview</label>',
        '<input type="radio" name="spec-tabs" id="spec-signals"><label for="spec-signals">Signals</label>',
        '<input type="radio" name="spec-tabs" id="spec-rollout"><label for="spec-rollout">Rollout</label>',
        '<div class="oct-tab-panel"><h2>Overview</h2><p>Recent activity outranks text match for the first three results. Below that, the existing text score decides.</p><div class="oct-callout oct-callout--warn"><p class="oct-callout__title">Open question</p><p>Should a pinned result survive a filter change?</p></div></div>',
        '<div class="oct-tab-panel"><h2>Signals</h2><div class="oct-table-wrap"><table class="oct-table"><thead><tr><th>Signal</th><th>Weight</th><th>Status</th></tr></thead><tbody><tr><td>Opened in the last day</td><td>0.6</td><td><span class="oct-badge oct-badge--success">Shipped</span></td></tr><tr><td>Title match</td><td>0.3</td><td><span class="oct-badge">Existing</span></td></tr><tr><td>Shared with me</td><td>0.1</td><td><span class="oct-badge oct-badge--warn">Testing</span></td></tr></tbody></table></div></div>',
        '<div class="oct-tab-panel"><h2>Rollout</h2><p>Ship behind a flag and compare a week of click-through.</p><pre class="oct-code"><code>search.rank.recent = true\nsearch.rank.weights = [0.6, 0.3, 0.1]</code></pre></div>',
        "</div>",
        "</article>",
      ].join(""),
    },
  ],
};

/**
 * A prototype that runs: a cart whose count and total change as the person
 * clicks. Its state lives in inline script, it asks the network for nothing,
 * and it styles itself, because a running design takes no workspace theme.
 */
export const cartPrototypeExample = {
  blockId: "cart-prototype",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "design" as const,
  title: "Cart",
  size: "phone" as const,
  runsScript: true as const,
  styles: [
    "body { margin: 0; font-family: system-ui, sans-serif; color: #1c1917; background: #fafaf9; }",
    ".screen { min-height: 100vh; display: flex; flex-direction: column; padding: 32px 24px; box-sizing: border-box; gap: 16px; }",
    "h1 { font-size: 28px; line-height: 1.15; margin: 0; }",
    ".row { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-radius: 14px; background: white; border: 1px solid #e7e5e4; }",
    ".stepper { display: flex; align-items: center; gap: 12px; }",
    "button { font: inherit; min-width: 44px; min-height: 44px; border-radius: 12px; border: 1px solid #d6d3d1; background: white; color: #1c1917; }",
    ".total { margin-top: auto; font-size: 20px; font-weight: 600; }",
  ].join("\n"),
  frames: [
    {
      frameId: "cart",
      title: "Cart",
      html: [
        '<main class="screen"><h1>Your cart</h1>',
        '<div class="row"><span>Noodle bowl, 12.00</span>',
        '<span class="stepper"><button type="button" aria-label="One fewer" onclick="change(-1)">-</button>',
        '<output id="count" aria-live="polite">1</output>',
        '<button type="button" aria-label="One more" onclick="change(1)">+</button></span></div>',
        '<p class="total">Total <output id="total" aria-live="polite">12.00</output></p></main>',
        "<script>",
        "var count = 1;",
        "function change(by) {",
        "  count = Math.max(0, count + by);",
        '  document.getElementById("count").textContent = String(count);',
        '  document.getElementById("total").textContent = (count * 12).toFixed(2);',
        "}",
        "</script>",
      ].join(""),
    },
  ],
};

function designBlock(value: unknown): CanvasDesignBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "design") {
    throw new Error("Design example did not decode as a design block.");
  }
  return block;
}

export const onboardingFlowExampleBlock = designBlock(onboardingFlowExample);
export const launchDeckExampleBlock = designBlock(launchDeckExample);
export const searchSpecExampleBlock = designBlock(searchSpecExample);
export const cartPrototypeExampleBlock = designBlock(cartPrototypeExample);
