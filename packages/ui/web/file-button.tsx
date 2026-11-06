import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "./button";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

// A button that opens the file chooser. The input stays in the page, so its
// label, accept and multiple still work for screen readers and tests.
export function FileButton({
  children,
  className,
  icon = "upload",
  variant = "default",
  iconOnly = false,
  title,
  onFiles,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  readonly children?: ReactNode;
  readonly icon?: IconName;
  readonly variant?: Exclude<ButtonVariant, "link">;
  // Only the icon shows, so give the input an aria-label.
  readonly iconOnly?: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}): ReactElement {
  return (
    <label
      title={title}
      className={buttonClass({
        variant,
        iconOnly,
        className: cn(
          "has-focus-visible:border-line-focus has-focus-visible:ring-4 has-focus-visible:ring-focus",
          className,
        ),
      })}
    >
      <Icon name={icon} className={iconOnly ? "" : "text-fg-dim"} />
      {children}
      <input
        type="file"
        className="sr-only"
        onChange={(event) => {
          const { files } = event.target;

          if (files && files.length > 0) {
            onFiles([...files]);
          }

          event.target.value = "";
        }}
        {...input}
      />
    </label>
  );
}
