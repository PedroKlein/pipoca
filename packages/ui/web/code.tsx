import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "./button";
import { cn } from "./cn";

// A block of code or output, on the code background.
export function Code({
  label,
  wrap = false,
  className,
  children,
}: {
  readonly label?: string;
  // Wraps long lines instead of scrolling them.
  readonly wrap?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <pre
      aria-label={label}
      className={cn(
        "overflow-x-auto rounded-[10px] border border-line bg-code px-3.5 py-3 font-mono text-mono-sm text-fg",
        wrap && "break-words whitespace-pre-wrap",
        className,
      )}
    >
      {children}
    </pre>
  );
}

// A command to run, with a button that copies it.
export function Command({
  label,
  children,
}: {
  readonly label: string;
  readonly children: string;
}): ReactElement {
  return (
    <div className="flex min-h-11.5 items-center gap-2.5 rounded-[10px] border border-line bg-code py-1.5 pr-1.5 pl-3.5">
      <pre
        aria-label={label}
        className="min-w-0 flex-1 font-mono text-mono break-all whitespace-pre-wrap text-fg-strong"
      >
        {children}
      </pre>
      <CopyButton text={children} />
    </div>
  );
}

// Copies text, and says so for a moment.
export function CopyButton({
  text,
  label,
  size = "sm",
}: {
  readonly text: string;
  // Names the button for screen readers when "Copy" alone is unclear.
  readonly label?: string;
  readonly size?: "sm" | "md";
}): ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size={size}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);

          setTimeout(() => {
            setCopied(false);
          }, 2000);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
