import {
  type ReactElement,
  memo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { PluginBoundary } from "../../plugin-boundary";
import { fillsOf } from "../../plugins";
import { renderMarkdown } from "./render-markdown";

function Markdown({ text }: { readonly text: string }): ReactElement {
  const prose = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<readonly Drawn[]>([]);

  useLayoutEffect(() => {
    setDrawn([...pluginLinks(prose.current), ...pluginBlocks(prose.current)]);
  }, [text]);

  return (
    <>
      <div
        ref={prose}
        className="prose"
        // Markdown output escapes raw HTML and unsafe links (markdown.ts).
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
      {drawn.map(({ node, plugin, element }, at) =>
        createPortal(
          <PluginBoundary name={plugin}>{element}</PluginBoundary>,
          node,
          at,
        ),
      )}
    </>
  );
}

interface Drawn {
  readonly node: Element;
  readonly plugin: string;
  readonly element: ReactElement;
}

// Links of a scheme no plugin draws keep their label as plain text.
function pluginLinks(prose: HTMLElement | null): Drawn[] {
  return [...(prose?.querySelectorAll("[data-link]") ?? [])].flatMap((node) => {
    const scheme = node.getAttribute("data-link") ?? "";
    const fill = fillsOf(`link:${scheme}`)[0];

    if (fill === undefined) {
      return [];
    }

    const label = node.textContent;
    node.textContent = "";

    return [
      {
        node,
        plugin: fill.plugin,
        element: (
          <fill.Component
            target={node.getAttribute("data-target") ?? ""}
            label={label}
          />
        ),
      },
    ];
  });
}

// Blocks of a language no plugin draws stay code.
function pluginBlocks(prose: HTMLElement | null): Drawn[] {
  return [...(prose?.querySelectorAll("[data-code-block]") ?? [])].flatMap(
    (node) => {
      const language = node.getAttribute("data-code-block") ?? "";
      const fill = fillsOf(`codeBlock:${language}`)[0];

      if (fill === undefined) {
        return [];
      }

      const code = node.textContent;
      node.textContent = "";

      return [
        {
          node,
          plugin: fill.plugin,
          element: <fill.Component code={code} />,
        },
      ];
    },
  );
}

export const Answer = memo(Markdown);
