import {
  decodeCanvasDocumentRecipe,
  type CanvasDocumentRecipe,
} from "@octant/contracts/canvas-skill";

/**
 * Starting shapes for documents people ask for often.
 *
 * Each skeleton names block kinds that exist today and the role that block
 * plays. It does not name a source, a file, or a block kind that is not in
 * the catalogue. Reference blocks are omitted on purpose: creating a Canvas
 * attaches no sources, so a recipe must not ask the author to invent one.
 */
const inTreeCanvasDocumentRecipeDocuments = [
  {
    id: "implementation-plan",
    title: "Implementation plan",
    whenToUse:
      "When someone asks to write a plan, an implementation plan, or how to build something.",
    skeleton: [
      { kind: "heading", role: "Goal" },
      { kind: "rich-text", role: "The goal and what is in scope." },
      { kind: "heading", role: "Plan" },
      { kind: "plan", role: "Phases, and tasks that name their phase, with a status." },
      { kind: "heading", role: "Risks" },
      { kind: "rich-text", role: "Risks, and what is out of scope." },
      { kind: "callout", role: "What done means for the plan." },
    ],
  },
  {
    id: "audit-report",
    title: "Audit report",
    whenToUse: "When someone asks for an audit, a test report, or what was checked.",
    skeleton: [
      { kind: "heading", role: "Scope" },
      { kind: "rich-text", role: "What was checked, and what was not." },
      { kind: "heading", role: "Result" },
      { kind: "status", role: "The overall result." },
      { kind: "heading", role: "Findings" },
      { kind: "table", role: "Findings, each with a severity and the evidence for it." },
      { kind: "rich-text", role: "What remains open." },
    ],
  },
  {
    id: "code-review",
    title: "Code review",
    whenToUse: "When someone asks to review a change or a pull request.",
    skeleton: [
      { kind: "heading", role: "Summary" },
      { kind: "rich-text", role: "What the change does." },
      { kind: "heading", role: "Findings" },
      { kind: "table", role: "Findings by severity." },
      { kind: "heading", role: "Change" },
      {
        kind: "diff",
        role: "The change, as text already in hand. Do not invent a file reference.",
      },
      { kind: "heading", role: "Follow-ups" },
      { kind: "rich-text", role: "What to do next." },
    ],
  },
  {
    id: "research-brief",
    title: "Research brief",
    whenToUse: "When someone asks to summarise research, compare options, or brief a question.",
    skeleton: [
      { kind: "heading", role: "Question" },
      { kind: "rich-text", role: "The question the brief answers." },
      { kind: "heading", role: "Sources" },
      { kind: "table", role: "Sources, and what each one established." },
      { kind: "heading", role: "Comparison" },
      { kind: "table", role: "How the options compare." },
      { kind: "heading", role: "Recommendation" },
      { kind: "rich-text", role: "The recommendation, and what is still unknown." },
    ],
  },
  {
    id: "postmortem",
    title: "Postmortem",
    whenToUse: "When someone asks for a postmortem, or what went wrong and what to do next.",
    skeleton: [
      { kind: "heading", role: "What happened" },
      { kind: "rich-text", role: "What happened." },
      { kind: "heading", role: "Timeline" },
      { kind: "timeline", role: "The events in order." },
      { kind: "heading", role: "Impact" },
      { kind: "metric", role: "The impact." },
      { kind: "heading", role: "Causes" },
      { kind: "diagram", role: "How the causes connect, as nodes and edges." },
      { kind: "heading", role: "Actions" },
      { kind: "plan", role: "The actions that follow." },
    ],
  },
  {
    id: "repository-map",
    title: "Repository map",
    whenToUse: "When someone asks to map a repository, a codebase, or how the code is organised.",
    skeleton: [
      { kind: "heading", role: "Repository" },
      {
        kind: "treemap",
        role: "The hierarchy sized by lines of code and coloured by edits in the last 60 days. Gather the numbers with your own tools.",
      },
      { kind: "heading", role: "Notes" },
      { kind: "rich-text", role: "What stands out, and what to look at next." },
    ],
  },
  {
    id: "design-prototype",
    title: "Design prototype",
    whenToUse:
      "When someone asks to design an app, a screen, a website, or a landing page, or for a mockup they can click through.",
    skeleton: [
      {
        kind: "design",
        role: "One frame per screen at phone, tablet, or desktop size, linked with href to each other's frameId.",
      },
      { kind: "heading", role: "Notes" },
      { kind: "rich-text", role: "The choices made, and what is still open." },
    ],
  },
  {
    id: "slide-deck",
    title: "Slide deck",
    whenToUse: "When someone asks for a presentation, a deck, or slides.",
    skeleton: [{ kind: "design", role: "One slide-size frame per slide, in order." }],
  },
  {
    id: "data-model",
    title: "Data model",
    whenToUse: "When someone asks to model data, diagram a schema, or describe how records relate.",
    skeleton: [
      { kind: "heading", role: "Overview" },
      { kind: "rich-text", role: "What the model covers." },
      {
        kind: "er",
        role: "Entities with their named, typed attributes, and relationships with a cardinality at each end.",
      },
      { kind: "rich-text", role: "What is deliberately out of scope." },
    ],
  },
] as const;

const inTreeRecipes = inTreeCanvasDocumentRecipeDocuments.map((recipe) =>
  decodeCanvasDocumentRecipe(recipe),
);

export function inTreeCanvasDocumentRecipes(): ReadonlyArray<CanvasDocumentRecipe> {
  return inTreeRecipes;
}
