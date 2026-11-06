// Who a team Session message goes to (ADR 0065).
export type Target = "pi" | "team" | "aside";

export const targets = [
  { value: "pi", label: "To Pi" },
  { value: "team", label: "To the team" },
  { value: "aside", label: "Off the record" },
] as const;

export const placeholders = {
  pi: "Message Pi",
  team: "Message the team. Pi reads it next time it's asked",
  aside: "Hidden from Pi, visible to the team",
} as const satisfies Record<Target, string>;
