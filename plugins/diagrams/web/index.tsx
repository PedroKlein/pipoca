import { type CodeBlockProps, defineWeb } from "@pipoca/plugins/web";
import {
  type ReactElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { diagrams } from "../plugin";
import { draw, drawnBefore, type Drawing } from "./draw";

export const web = defineWeb(diagrams, {
  slots: { "codeBlock:mermaid": Diagram },
});

function Diagram({ code }: CodeBlockProps): ReactElement {
  const theme = useSyncExternalStore(onThemeChange, currentTheme);
  const [latest, setLatest] = useState<Drawing>();
  const drawing = drawnBefore(code, theme) ?? latest;

  useEffect(() => {
    let shown = true;

    void draw(code, theme).then((next) => {
      if (shown) {
        setLatest(next);
      }
    });

    return () => {
      shown = false;
    };
  }, [code, theme]);

  if (drawing?.code === code && "svg" in drawing) {
    return (
      <div
        className="overflow-x-auto"
        // Mermaid's strict mode sanitizes the SVG it returns (draw.ts).
        dangerouslySetInnerHTML={{ __html: drawing.svg }}
      />
    );
  }

  return (
    <>
      <pre>
        <code>{code}</code>
      </pre>
      {drawing?.code === code && "error" in drawing && (
        <p className="text-caption text-failed">
          {`This diagram didn't draw: ${drawing.error}`}
        </p>
      )}
    </>
  );
}

function currentTheme(): string {
  return document.documentElement.dataset["theme"] ?? "";
}

function onThemeChange(changed: () => void): () => void {
  const observer = new MutationObserver(changed);

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return () => {
    observer.disconnect();
  };
}
