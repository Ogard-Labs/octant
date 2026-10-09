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
    summary: "Goal, phased tasks with status, risks, and what done means.",
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
    summary: "Scope, the overall result, findings with evidence, and what remains open.",
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
    summary: "What a change does, findings by severity, the diff, and follow-ups.",
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
    summary: "The question, sources, an options matrix, and a recommendation.",
    whenToUse: "When someone asks to summarise research, compare options, or brief a question.",
    skeleton: [
      { kind: "heading", role: "Question" },
      { kind: "rich-text", role: "The question the brief answers." },
      { kind: "heading", role: "Sources" },
      { kind: "table", role: "Sources, and what each one established." },
      { kind: "heading", role: "Comparison" },
      {
        kind: "comparison-matrix",
        role: "The options against the criteria that decide between them, with the one recommended.",
      },
      { kind: "heading", role: "Recommendation" },
      { kind: "rich-text", role: "The recommendation, and what is still unknown." },
    ],
  },
  {
    id: "postmortem",
    title: "Postmortem",
    summary: "What happened, a timeline, impact, causes, and the actions that follow.",
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
    summary: "A treemap of the codebase by size and recent edits, with notes.",
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
    summary: "Clickable screens at phone, tablet, or desktop size, with notes.",
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
    summary: "One slide-size frame per slide, in order.",
    whenToUse: "When someone asks for a presentation, a deck, or slides.",
    skeleton: [{ kind: "design", role: "One slide-size frame per slide, in order." }],
  },
  {
    id: "data-model",
    title: "Data model",
    summary: "Entities, attributes, and relationships, with what is out of scope.",
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
  {
    id: "architecture-review",
    title: "Architecture review",
    summary: "Context, the options weighed in a matrix, the decision, and its consequences.",
    whenToUse:
      "When someone asks for an architecture review, an ADR, or to decide between designs.",
    skeleton: [
      { kind: "heading", role: "Context" },
      { kind: "rich-text", role: "The problem, the forces at play, and what is fixed." },
      { kind: "heading", role: "Options" },
      {
        kind: "comparison-matrix",
        role: "Options matrix: each option against the weighted criteria, with the one recommended.",
      },
      { kind: "heading", role: "Decision" },
      { kind: "status", role: "The decision's state: proposed, accepted, or superseded." },
      { kind: "rich-text", role: "What was decided, and why." },
      { kind: "heading", role: "Consequences" },
      { kind: "rich-text", role: "What becomes easier, what becomes harder, and what to revisit." },
    ],
  },
  {
    id: "design-spec",
    title: "Design spec",
    summary: "The problem, goals and non-goals, the design, and its open questions.",
    whenToUse:
      "When someone asks for a design spec, a technical design, or how a feature should work.",
    skeleton: [
      { kind: "heading", role: "Problem" },
      { kind: "rich-text", role: "The problem and who has it." },
      { kind: "heading", role: "Goals" },
      { kind: "key-value", role: "Goals and non-goals, one per row." },
      { kind: "heading", role: "Design" },
      { kind: "rich-text", role: "How it works." },
      { kind: "diagram", role: "The parts and how they connect, as nodes and edges." },
      { kind: "heading", role: "Open questions" },
      { kind: "table", role: "Open questions, each with an owner." },
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard",
    summary: "Headline metrics, a trend chart, a ranking, and what needs attention.",
    whenToUse: "When someone asks for a dashboard, a status overview, or key numbers at a glance.",
    skeleton: [
      { kind: "metric", role: "The headline number, with its direction." },
      { kind: "metric", role: "A second headline number." },
      { kind: "chart", role: "The trend over time." },
      { kind: "bar-list", role: "The largest contributors, ranked." },
      { kind: "status", role: "The overall state." },
      { kind: "callout", role: "What needs attention now." },
    ],
  },
] as const;

const inTreeRecipes = inTreeCanvasDocumentRecipeDocuments.map((recipe) =>
  decodeCanvasDocumentRecipe(recipe),
);

export function inTreeCanvasDocumentRecipes(): ReadonlyArray<CanvasDocumentRecipe> {
  return inTreeRecipes;
}
