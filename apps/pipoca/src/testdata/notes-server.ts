import { BadRequest, type Caller, defineServer, Type } from "@pipoca/plugins";
import { notes } from "./notes";

const note = Type.Object({ text: Type.String({ minLength: 1 }) });

function who(caller: Caller): unknown {
  return {
    kind: caller.kind,
    person: caller.person?.name ?? null,
    owner: "owner" in caller ? caller.owner : null,
  };
}

export const server = defineServer(notes, ({ routes, urls }) => {
  routes.get("whoami", { auth: "person" }, ({ caller }) => who(caller));
  routes.put("settings", { auth: "admin" }, () => undefined);
  routes.post("beats", { auth: "session" }, ({ caller }) => who(caller));
  routes.get("hello", { auth: "public" }, ({ caller }) => who(caller));

  routes.get("callback", { auth: "public" }, ({ raw }) => {
    const response = Response.json({
      url: urls.public("callback"),
      state: urls.cookie.get(raw, "state") ?? null,
    });

    urls.cookie.set(response, "state", "abc", 600);

    return response;
  });

  routes.post(
    "hooks/:name",
    {
      auth: {
        webhook: {
          secret: ({ name }) => (name === "github" ? "s3cret" : undefined),
          maxBytes: 64,
        },
      },
      body: note,
    },
    ({ params, body }) => ({ name: params.name, text: body.text }),
  );

  routes.post(
    "notes",
    { auth: "person", body: note, changes: ["notes"] },
    ({ body }) => {
      if (body.text === "fail") {
        throw new BadRequest("That note fails.");
      }

      return body;
    },
  );

  routes.post("marks", { auth: "person", changes: ["marks"] }, () => undefined);

  routes.get("lists", { auth: "person", team: true }, ({ caller }) => ({
    owner: caller.owner,
  }));
});
