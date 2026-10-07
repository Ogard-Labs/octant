import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasDesignBlock } from "@octant/contracts/canvas";

/**
 * The designs an agent is shown when it asks how to write one: a clickable
 * phone flow, and a short deck. Wire shapes, not branded blocks: describe
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

export const launchDeckExample = {
  blockId: "launch-deck",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "design" as const,
  title: "Launch plan",
  size: "slide" as const,
  styles: [
    "body { margin: 0; font-family: system-ui, sans-serif; background: #0c0a09; color: #fafaf9; }",
    ".slide { width: 100vw; height: 100vh; box-sizing: border-box; padding: 120px 160px; display: flex; flex-direction: column; justify-content: center; gap: 32px; }",
    "h1 { font-size: 96px; margin: 0; }",
    "h2 { font-size: 64px; margin: 0; }",
    "li { font-size: 40px; line-height: 1.5; }",
  ].join("\n"),
  frames: [
    {
      frameId: "title",
      title: "Title",
      html: '<section class="slide"><h1>Launch plan</h1><p style="font-size:40px;color:#a8a29e">Spring release</p></section>',
    },
    {
      frameId: "goals",
      title: "Goals",
      html: '<section class="slide"><h2>Goals</h2><ul><li>Ship to every region</li><li>Halve first-order time</li></ul></section>',
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
