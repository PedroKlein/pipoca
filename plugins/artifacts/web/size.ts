import { useEffect, useState } from "react";

// An element's size as it changes, such as the frame the comment box sits
// in.
export function useSize(): readonly [
  (element: HTMLElement | null) => void,
  { readonly width: number; readonly height: number },
] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [element]);

  return [setElement, size] as const;
}
