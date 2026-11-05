import { Type } from "typebox";
import type { Wire } from "./wire";

// Every code the kernel's own routes answer with. Plugins add their own
// (ADR 0047).
export const errorCodes = [
  "bad_request",
  "invalid",
  "unauthorized",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "unsupported_media_type",
  "conflict",
  "too_large",
  "too_many_requests",
  "internal",
  "unavailable",
  "admin_only",
  "signed_out",
  "foreign_origin",
  "unsupported_version",
  "unknown_key",
  "unknown_token",
  "invalid_token",
  "invalid_invite",
  "invalid_challenge",
  "password_login_off",
  "wrong_password",
  "locked",
  "name_taken",
  "last_admin",
  "busy",
  "runner_online",
  "invalid_config",
  "config_changed",
  "config_locked",
  "stale_generation",
  "offline",
  "archived",
  "not_kept",
  "unknown_environment",
  "environment_exists",
  "unknown_template",
  "from_template",
  "environment_in_use",
  "unknown_profile",
  "not_movable",
  "unknown_entry",
  "not_team",
  "not_starter",
  "not_personal",
  "view_only",
  "default",
  "in_use",
  "team",
  "synced",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

// Every error has this body: a code a program checks and a sentence a person
// reads. A schema failure also names the field, such as workspace.path
// (ADR 0047).
export const apiError = Type.Object(
  {
    error: Type.String(),
    message: Type.String(),
    field: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type ApiError = Wire<typeof apiError>;
