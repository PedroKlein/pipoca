import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useState,
} from "react";

const gutter = 16;
const gap = 4;

export interface Anchored {
  readonly style: CSSProperties;
  // The height there is room for on the side it opens toward.
  readonly room: number | undefined;
}

// Where a picker's panel opens: beside its trigger toward the side with more
// room, kept inside the screen's 16px gutter, and fixed to the screen so a
// scrolling or clipping column around the trigger, such as a side panel,
// doesn't cut it off. It follows the trigger as the page scrolls.
export function useAnchored(
  trigger: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
): Anchored {
  const [anchored, setAnchored] = useState<Anchored>({
    style: { position: "fixed", visibility: "hidden" },
    room: undefined,
  });

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const place = (): void => {
      const anchor = trigger.current;
      const box = panel.current;

      if (anchor === null || box === null) {
        return;
      }

      const { top, bottom, left, right } = anchor.getBoundingClientRect();
      const above = innerHeight - bottom < top;
      const end = innerWidth - left < right;
      const width = box.offsetWidth;
      const start = end ? right - width : left;

      setAnchored({
        style: {
          position: "fixed",
          left: Math.max(gutter, Math.min(start, innerWidth - gutter - width)),
          ...(above
            ? { bottom: innerHeight - top + gap }
            : { top: bottom + gap }),
        },
        room: (above ? top : innerHeight - bottom) - gap - gutter,
      });
    };

    place();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);

    return () => {
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, [open, trigger, panel]);

  return anchored;
}
