import bundleCss from "../systems/pipoca/bundle.css" with { type: "text" };
import buttonHtml from "../systems/pipoca/components/Button/preview.html" with { type: "text" };
import calloutHtml from "../systems/pipoca/components/Callout/preview.html" with { type: "text" };
import cardHtml from "../systems/pipoca/components/Card/preview.html" with { type: "text" };
import kpiHtml from "../systems/pipoca/components/KPI/preview.html" with { type: "text" };
import tableHtml from "../systems/pipoca/components/Table/preview.html" with { type: "text" };
import tagHtml from "../systems/pipoca/components/Tag/preview.html" with { type: "text" };
import titleSlideHtml from "../systems/pipoca/components/TitleSlide/preview.html" with { type: "text" };
import readmeMd from "../systems/pipoca/README.md" with { type: "text" };
import tokensCss from "../systems/pipoca/tokens.css" with { type: "text" };
import tokensJson from "../systems/pipoca/tokens.json" with { type: "text" };

// Pipoca's own design system, which ships with it as built-in templates do.
export const pipoca: Readonly<Record<string, string>> = {
  "tokens.json": text(tokensJson),
  "tokens.css": text(tokensCss),
  "bundle.css": text(bundleCss),
  "README.md": text(readmeMd),
  "components/Button/preview.html": text(buttonHtml),
  "components/Callout/preview.html": text(calloutHtml),
  "components/Card/preview.html": text(cardHtml),
  "components/KPI/preview.html": text(kpiHtml),
  "components/Table/preview.html": text(tableHtml),
  "components/Tag/preview.html": text(tagHtml),
  "components/TitleSlide/preview.html": text(titleSlideHtml),
};

function text(file: unknown): string {
  if (typeof file !== "string") {
    throw new Error("a built-in design system's file isn't text");
  }

  return file;
}
