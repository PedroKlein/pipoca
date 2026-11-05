import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "./cn";

const variants = {
  default:
    "border-line bg-elevated text-fg shadow-xs hover:border-line-strong hover:bg-hover",
  primary: "border-accent bg-accent text-on-accent shadow-xs hover:opacity-90",
  ghost:
    "border-transparent bg-transparent text-fg-dim hover:bg-hover hover:text-fg",
  danger: "border-failed bg-failed-tint text-failed hover:brightness-110",
} as const;

const sizes = {
  sm: ["h-7 text-label", "px-2.5", "w-7"],
  md: ["h-control text-ui", "px-3", "w-control"],
  lg: ["h-11 rounded-[11px] text-prose", "px-5", "w-11"],
} as const;

export type ButtonVariant = keyof typeof variants | "link";
export type ButtonSize = keyof typeof sizes;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly iconOnly?: boolean;
}

export function Button({
  variant = "default",
  size = "md",
  iconOnly = false,
  className,
  type = "button",
  ...props
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, iconOnly, className })}
      {...props}
    />
  );
}

// A link drawn as text with an underline, for an action inside a sentence.
const linkClass =
  "inline cursor-pointer font-medium text-fg underline decoration-line-strong underline-offset-3 hover:decoration-fg disabled:pointer-events-none disabled:opacity-45";

// Button's classes, for a link or label that looks like one.
export function buttonClass({
  variant = "default",
  size = "md",
  iconOnly = false,
  className,
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly iconOnly?: boolean;
  readonly className?: string | undefined;
} = {}): string {
  if (variant === "link") {
    return cn(linkClass, className);
  }

  const [height, padding, width] = sizes[size];

  return cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-[background-color,border-color,opacity,transform] duration-150 select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 pointer-coarse:min-h-touch",
    height,
    iconOnly ? `${width} pointer-coarse:min-w-touch` : padding,
    variants[variant],
    className,
  );
}
