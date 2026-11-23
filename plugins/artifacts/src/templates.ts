import decisionMd from "../templates/decision-record/decision.md" with { type: "text" };
import decisionRecord from "../templates/decision-record/template.json";
import designMd from "../templates/design-doc/design.md" with { type: "text" };
import designDoc from "../templates/design-doc/template.json";
import reviewMd from "../templates/incident-review/review.md" with { type: "text" };
import incidentReview from "../templates/incident-review/template.json";
import canvasJson from "../templates/mockup-canvas/canvas.json" with { type: "text" };
import mainHtml from "../templates/mockup-canvas/Main.html" with { type: "text" };
import mockupCanvas from "../templates/mockup-canvas/template.json";
import reportHtml from "../templates/report-page/index.html" with { type: "text" };
import stylesCss from "../templates/report-page/styles.css" with { type: "text" };
import reportPage from "../templates/report-page/template.json";
import deckCss from "../templates/slide-deck/deck.css" with { type: "text" };
import deckHtml from "../templates/slide-deck/deck.html" with { type: "text" };
import slideDeck from "../templates/slide-deck/template.json";
import { type Purpose, purposes } from "./artifacts";

// A template that ships with Pipoca: its manifest, and its files as text by
// path, which no one edits.
export interface BuiltIn {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly for: Purpose;
  readonly entry: string;
  readonly instructions: string;
  readonly files: Readonly<Record<string, string>>;
}

interface Manifest {
  readonly name: string;
  readonly description: string;
  readonly for: string;
  readonly entry: string;
  readonly instructions: string;
}

// Imported with type text, whatever the file's own type says.
function text(file: unknown): string {
  if (typeof file !== "string") {
    throw new Error("a built-in template's file isn't text");
  }

  return file;
}

function builtIn(
  id: string,
  manifest: Manifest,
  files: Readonly<Record<string, unknown>>,
): BuiltIn {
  if (!purposes.includes(manifest.for as Purpose)) {
    throw new Error(`template ${id} is for ${manifest.for}`);
  }

  return {
    id,
    ...manifest,
    for: manifest.for as Purpose,
    files: Object.fromEntries(
      Object.entries(files).map(([path, file]) => [path, text(file)]),
    ),
  };
}

export const builtIns: readonly BuiltIn[] = [
  builtIn("slide-deck", slideDeck, {
    "deck.html": deckHtml,
    "deck.css": deckCss,
  }),
  builtIn("decision-record", decisionRecord, { "decision.md": decisionMd }),
  builtIn("design-doc", designDoc, { "design.md": designMd }),
  builtIn("incident-review", incidentReview, { "review.md": reviewMd }),
  builtIn("mockup-canvas", mockupCanvas, {
    "canvas.json": canvasJson,
    "Main.html": mainHtml,
  }),
  builtIn("report-page", reportPage, {
    "index.html": reportHtml,
    "styles.css": stylesCss,
  }),
];
