import { createContext, type ReactElement, type ReactNode, use } from "react";
import { cn } from "./cn";

const InPage = createContext(false);

// The column a Settings or plugin page sits in, with its title when given.
// Inside another Page, such as a plugin's page in the shell's column, it
// draws only its title and content.
export function Page({
  id,
  title,
  description,
  actions,
  label,
  wide = false,
  className,
  children,
}: {
  readonly id?: string;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly label?: string;
  // A 1000px column for a dashboard, such as the Team hub's home.
  readonly wide?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const nested = use(InPage);

  return (
    <div
      id={id}
      aria-label={label}
      className={cn(
        "flex w-full flex-col",
        !nested &&
          cn(
            "mx-auto px-4 pt-8 pb-12 md:px-12 md:pt-11 md:pb-18",
            wide ? "max-w-page-wide" : "max-w-page",
          ),
        className,
      )}
    >
      {title !== undefined && (
        <PageTitle description={description} actions={actions}>
          {title}
        </PageTitle>
      )}
      <InPage value>{children}</InPage>
    </div>
  );
}

function PageTitle({
  children,
  description,
  actions,
}: {
  readonly children: ReactNode;
  readonly description?: ReactNode;
  // Buttons at the top right, such as Add.
  readonly actions?: ReactNode;
}): ReactElement {
  return (
    <header className="mb-6 flex items-start gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h1 className="text-display font-medium tracking-tight text-fg-strong">
          {children}
        </h1>
        {description !== undefined && (
          <p className="max-w-145 text-ui text-fg-dim">{description}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="mt-7 flex shrink-0 gap-2">{actions}</div>
      )}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  readonly title: ReactNode;
  // A few words beside the title.
  readonly description?: ReactNode;
  // Buttons at the end of the title's line, such as Add.
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="mt-8 flex flex-col gap-2.5">
      <div className="flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className="text-prose font-semibold text-fg-strong">{title}</h2>
        {description !== undefined && (
          <span className="text-label text-fg-dim">{description}</span>
        )}
        {actions !== undefined && (
          <div className="ml-auto flex gap-2">{actions}</div>
        )}
      </div>
      {children}
    </section>
  );
}
