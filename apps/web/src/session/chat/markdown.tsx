import type { WebPlugin } from "@pipoca/plugins/web";
import {
  type ReactElement,
  memo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext } from "../../plugins";
import { renderMarkdown } from "./render-markdown";

export function Markdown({ text }: { readonly text: string }): ReactElement {
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
            <Drawn
              context={pluginContext(plugin)}
              target={target}
              label={label}
            />
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
  readonly Drawn: NonNullable<WebPlugin["links"]>[string];
  readonly target: string;
  readonly label: string;
}

// Links of a scheme no plugin draws keep their label as plain text.
function pluginLinks(prose: HTMLElement | null): PluginLink[] {
  return [...(prose?.querySelectorAll("[data-link]") ?? [])].flatMap((node) => {
    const scheme = node.getAttribute("data-link") ?? "";
    const plugin = enabledPlugins().find(({ links }) => links?.[scheme]);
    const Drawn = plugin?.links?.[scheme];

    if (plugin === undefined || Drawn === undefined) {
      return [];
    }

    const label = node.textContent;
    node.textContent = "";

    return [
      {
        node,
        plugin: plugin.name,
        Drawn,
        target: node.getAttribute("data-target") ?? "",
        label,
      },
    ];
  });
}

export const Answer = memo(Markdown);
