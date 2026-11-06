import { cn, Code, StatusMark } from "@pipoca/ui";
import type { ReactElement } from "react";
import { describeTool, type Step, stepStatus } from "./chat";

export function StepRow({
  step,
  running,
  open,
}: {
  readonly step: Step;
  readonly running: boolean;
  readonly open: boolean;
}): ReactElement {
  const { verb, object } = describeTool(step.name, step.args);

  const line = (
    <>
      <StatusMark
        status={stepStatus(running, step.result?.failed === true)}
        label=""
      />
      <span className="shrink-0 font-medium text-fg">{verb}</span>
      <span className="truncate font-mono text-mono-sm text-fg-dim">
        {object}
      </span>
    </>
  );

  const row = "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-label";

  if (!step.result || step.result.text === "") {
    return <div className={row}>{line}</div>;
  }

  return (
    <details open={open} className="group/step">
      <summary
        className={cn(
          row,
          "cursor-pointer list-none hover:bg-hover [&::-webkit-details-marker]:hidden",
        )}
      >
        {line}
      </summary>
      <Code
        wrap
        failed={step.result.failed}
        className="mx-2 mt-1 mb-2 max-h-80 overflow-auto"
      >
        {step.result.text}
      </Code>
    </details>
  );
}
