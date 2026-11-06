import { expect, test } from "bun:test";
import { act, useState } from "react";
import { Slider } from "./slider";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

const levels = ["off", "low", "medium", "high"] as const;

type Level = (typeof levels)[number];

function press(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

function saved(): {
  readonly asked: Level[];
  readonly save: (level: Level) => void;
  readonly page: HTMLElement;
} {
  const asked: Level[] = [];
  let save: (level: Level) => void = () => undefined;

  function Saved() {
    const [value, setValue] = useState<Level>("off");
    save = setValue;

    return (
      <Slider
        label="Reasoning"
        stops={levels.map((level) => ({ value: level, label: level }))}
        value={value}
        onChange={(level) => {
          asked.push(level);
        }}
      />
    );
  }

  const page = render(<Saved />);

  return {
    asked,
    save: (level) => {
      act(() => {
        save(level);
      });
    },
    page,
  };
}

test("moves one level per arrow key", () => {
  const { asked, page } = saved();
  const slider = byRole(page, "slider", "Reasoning");

  press(slider, "ArrowRight");
  press(slider, "ArrowRight");
  press(slider, "ArrowLeft");

  expect(asked).toEqual(["low", "medium", "low"]);
});

test("moves on from the level it last asked for while earlier ones are saved", () => {
  const { asked, save, page } = saved();
  const slider = byRole(page, "slider", "Reasoning");

  click(page.querySelector('[title="high"]'));
  press(slider, "ArrowLeft");
  save("high");
  press(slider, "ArrowRight");

  expect(asked).toEqual(["high", "medium", "high"]);

  save("medium");
  save("high");

  expect(slider.getAttribute("aria-valuetext")).toBe("high");
});

test("follows a level saved elsewhere", () => {
  const { asked, save, page } = saved();
  const slider = byRole(page, "slider", "Reasoning");

  press(slider, "ArrowRight");
  save("high");

  expect(slider.getAttribute("aria-valuetext")).toBe("high");

  press(slider, "ArrowLeft");

  expect(asked).toEqual(["low", "medium"]);
});
