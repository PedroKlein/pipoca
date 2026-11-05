import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn";
import { fieldClass } from "./field";

// A text field with the shared field look. Put it in a Field for its label.
export function TextInput({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly ref?: Ref<HTMLInputElement>;
}): ReactElement {
  return <input ref={ref} className={cn(fieldClass, className)} {...props} />;
}

// A textarea that grows with its text (style.css), with the field look.
export function TextArea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  readonly ref?: Ref<HTMLTextAreaElement>;
}): ReactElement {
  return (
    <textarea ref={ref} className={cn(fieldClass, className)} {...props} />
  );
}

type BoxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  // A small one in a toolbar, such as Show archived.
  readonly size?: "sm" | "md";
};

function Box({
  type,
  label,
  description,
  size = "md",
  className,
  ...props
}: BoxProps & { readonly type: "checkbox" | "radio" }): ReactElement {
  return (
    <label
      className={cn(
        "flex cursor-pointer has-disabled:cursor-default has-disabled:opacity-60",
        size === "sm"
          ? "items-center gap-1.5 text-caption text-fg-dim"
          : "items-start gap-2.5 text-ui text-fg",
        className,
      )}
    >
      <input
        type={type}
        className={cn(
          "shrink-0 cursor-pointer accent-(--accent) disabled:cursor-default",
          size === "sm" ? "size-3.5" : "mt-0.5 size-4",
        )}
        {...props}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        {description !== undefined && (
          <span className="text-label text-fg-dim">{description}</span>
        )}
      </span>
    </label>
  );
}

export function Checkbox(props: BoxProps): ReactElement {
  return <Box type="checkbox" {...props} />;
}

export function Radio(props: BoxProps): ReactElement {
  return <Box type="radio" {...props} />;
}
