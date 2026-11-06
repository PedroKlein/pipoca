import type { LinkProps } from "@pipoca/plugins/web";
import {
  type ComponentType,
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
  const [links, setLinks] = useState<readonly PluginLink[]>([]);

  useLayoutEffect(() => {
    setLinks(pluginLinks(prose.current));
  }, [text]);

  return (
    <>
      <div
        ref={prose}
        className="prose"
        // Markdown output escapes raw HTML and unsafe links (markdown.ts).
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
      {links.map(({ node, plugin, Drawn, target, label }, at) =>
        createPortal(
          <PluginBoundary name={plugin}>
            <Drawn target={target} label={label} />
          </PluginBoundary>,
          node,
          at,
        ),
      )}
    </>
  );
}

interface PluginLink {
  readonly node: Element;
  readonly plugin: string;
  readonly Drawn: ComponentType<LinkProps>;
  readonly target: string;
  readonly label: string;
}

// Links of a scheme no plugin draws keep their label as plain text.
function pluginLinks(prose: HTMLElement | null): PluginLink[] {
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
        Drawn: fill.Component,
        target: node.getAttribute("data-target") ?? "",
        label,
      },
    ];
  });
}

export const Answer = memo(Markdown);
