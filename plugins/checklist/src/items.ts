export const toolName = "update_checklist";

export const statuses = ["pending", "in_progress", "completed"] as const;

export interface Item {
  readonly text: string;
  readonly status: (typeof statuses)[number];
}
