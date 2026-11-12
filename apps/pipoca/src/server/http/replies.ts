import { HttpError } from "@pipoca/plugins";
import type { ErrorCode } from "@pipoca/protocol";
import type { Rejection as EnvironmentRejection } from "@pipoca/environments";
import type { Rejection as SessionRejection } from "@pipoca/sessions";

type Rejection = SessionRejection | EnvironmentRejection;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

const rejections = {
  not_found: [404, "Not found."],
  stale_generation: [409, "The Session has moved on since this was sent."],
  offline: [409, "The Session's runner is offline."],
  archived: [409, "The Session is archived."],
  not_kept: [409, "The Session has no kept workspace to remove."],
  unknown_environment: [400, "There is no such Environment."],
  unreachable_host: [
    409,
    "The repository is on a private host this Environment doesn't reach.",
  ],
  environment_exists: [409, "An Environment of that name already exists."],
  unknown_template: [400, "There is no such template."],
  from_template: [
    409,
    "The Environment's template sets its isolation, image and setup script.",
  ],
  environment_in_use: [
    409,
    "Archive the Environment's Sessions before deleting it.",
  ],
  unknown_profile: [400, "There is no such Profile."],
  not_movable: [
    409,
    "The Session's workspace can't move to another Environment.",
  ],
  unknown_entry: [400, "That isn't one of the Session's messages."],
  not_team: [
    409,
    "Only team work is limited. A personal Session is its person's alone.",
  ],
  not_starter: [403, "Only whoever started it, or an admin, limits team work."],
  not_personal: [409, "This is team work already."],
  view_only: [
    403,
    "This team work is view-only. Only whoever started it steers it.",
  ],
} as const satisfies Record<Rejection, readonly [number, string]>;

// Every error the API answers has this body: a code a program can check and
// the message a person reads (ADR 0047).
export function errorReply(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  return Response.json({ ...details, error: code, message }, { status });
}

// What a route or plugin threw. A plugin that bundles an SDK from before
// codes throws none (ADR 0046), so its status gives one.
export function thrown(error: HttpError): Response {
  const { status, code, message } = new HttpError(
    error.status,
    error.message,
    (error as Partial<HttpError>).code,
  );

  return Response.json(
    { ...(error as Partial<HttpError>).details, error: code, message },
    { status },
  );
}

export function rejected(reason: Rejection): Response {
  const [status, message] = rejections[reason];

  return errorReply(status, reason, message);
}

export function rejection(reason: Rejection): HttpError {
  const [status, message] = rejections[reason];

  return new HttpError(status, message, reason);
}

// A domain's result, or the error its reason answers with.
export function ok<T>(result: Result<T>): T {
  if (!result.ok) {
    throw rejection(result.reason);
  }

  return result.value;
}

export function reply(result: Result<unknown>, status: number): Response {
  if (!result.ok) {
    return rejected(result.reason);
  }

  return result.value === undefined
    ? new Response(null, { status })
    : Response.json(result.value, { status });
}

export function notFound(): Response {
  return rejected("not_found");
}
