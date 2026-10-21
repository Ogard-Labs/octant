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
    id: "memo",
    title: "Memo",
    summary: "A one-page memo or report: the summary, the facts, the detail, and the ask.",
    whenToUse:
      "When someone asks for a memo, a one-pager, a status report, a summary to decide from, or a short write-up to share.",
    skeleton: [
      { kind: "heading", role: "Summary" },
      { kind: "rich-text", role: "The answer in a few sentences, and why it matters." },
      { kind: "heading", role: "Facts" },
      { kind: "key-value", role: "The facts the reader needs, one per row." },
      { kind: "heading", role: "Detail" },
      { kind: "table", role: "The supporting detail, one row per item." },
      { kind: "heading", role: "Next steps" },
      { kind: "callout", role: "The decision or action asked of the reader, and by when." },
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
  {
    id: "article",
    title: "Article",
    summary: "A finished article in the workspace theme: a title, a lede, and sections.",
    whenToUse:
      "When someone asks for an article, an essay, a write-up, a blog post, or a long explanation to read.",
    skeleton: [
      {
        kind: "design",
        size: "document",
        role: "The article as one themed document: a title, a lede, and sections of prose, built from the frame kit.",
      },
    ],
  },
  {
    id: "design-brief",
    title: "Design brief",
    summary:
      "A product or game brief: the pitch, then its areas in tabs with numbers, flows, and a plan.",
    whenToUse:
      "When someone asks for a product brief, a game design document, a concept, or a pitch for something to build.",
    skeleton: [
      {
        kind: "design",
        size: "document",
        role: "The pitch as a themed document: what it is, who it is for, and the pillars.",
      },
      { kind: "tabs", role: "One tab per area, each naming the blocks below that belong to it." },
      { kind: "metric", role: "A target number for the brief, with its unit." },
      { kind: "diagram", role: "The core loop or main flow, with node roles and edge styles." },
      { kind: "table", role: "The content or feature list, one row per item." },
      { kind: "plan", role: "Milestones with dates, shown as a Gantt view." },
      { kind: "callout", role: "The biggest risk, and what would reduce it." },
    ],
  },
  {
    id: "design-system",
    title: "Design system",
    summary:
      "Colour, type, spacing, and components shown as a themed document, with a token table.",
    whenToUse:
      "When someone asks for a design system, a style guide, a component library overview, or brand guidelines.",
    skeleton: [
      {
        kind: "design",
        size: "document",
        role: "The system as a themed document: colour, type scale, spacing, and components with their states.",
      },
      { kind: "heading", role: "Tokens" },
      { kind: "table", role: "Each token: its name, its value, and where it is used." },
      { kind: "heading", role: "Rules" },
      { kind: "rich-text", role: "How to use the system, and what is still open." },
    ],
  },
  {
    id: "clickable-prototype",
    title: "Clickable prototype",
    summary: "A prototype that reacts and keeps state as you click, with notes on what is real.",
    whenToUse:
      "When someone asks for a working prototype, a demo they can try, or an interaction that keeps state, such as a cart, a form that validates, or a small game.",
    skeleton: [
      {
        kind: "design",
        role: "A design with runsScript true: one frame per screen, its state in inline script, no network.",
      },
      { kind: "heading", role: "Notes" },
      { kind: "rich-text", role: "What the prototype shows, what is faked, and what to try." },
    ],
  },
  {
    id: "app-redesign-prototype",
    title: "App redesign prototype",
    summary: "A whole app window you can click through, with real navigation and a live accent.",
    whenToUse:
      "When someone asks to redesign an app, show a full app window, or try a layout with real navigation, state, and a colour they can change, such as a sidebar of threads, panes, tabs, and an accent picker.",
    skeleton: [
      {
        kind: "design",
        size: "desktop",
        role: "Desktop window, runsScript true, accent as a :root variable; grow it with designEdits revisions.",
      },
      { kind: "heading", role: "Notes" },
      {
        kind: "rich-text",
        role: "What the window shows, what is faked, and what to try, such as changing the accent.",
      },
    ],
  },
] as const;

const inTreeRecipes = inTreeCanvasDocumentRecipeDocuments.map((recipe) =>
  decodeCanvasDocumentRecipe(recipe),
);

export function inTreeCanvasDocumentRecipes(): ReadonlyArray<CanvasDocumentRecipe> {
  return inTreeRecipes;
}
