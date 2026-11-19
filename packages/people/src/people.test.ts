import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { InvalidCredentials, People, SignIn } from "./index";
import { memoryStore } from "./testdata/memory-store";

function clock() {
  let now = Date.parse("2026-11-05T12:00:00Z");

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function server(options: { readonly solo?: string } = {}) {
  const store = memoryStore();
  const time = clock();
  const people = new People(store, { clock: time, ...options });
  const signIn = new SignIn(people, store, { clock: time });

  return { people, signIn, time };
}

const request = (cookie = "") =>
  new Request("http://localhost/", { headers: { cookie } });

const cookieOf = (setCookie: string) => setCookie.split(";")[0] ?? "";

test("keeps an admin: the last one can't stop being one", async () => {
  const { people, signIn } = server();

  const first = await signIn.setUp(signIn.setupToken ?? "", {
    name: "ana",
    password: "a long password",
  });

  const bea = people.createUser("bea", false);

  expect(people.changeRole(first?.id ?? "", false)).toBe("last_admin");
  expect(people.changeRole("nobody", true)).toBe("not_found");
  expect(people.changeRole(bea?.id ?? "", true)).toMatchObject({ admin: true });

  expect(people.changeRole(first?.id ?? "", false)).toMatchObject({
    admin: false,
  });
});

test("the setup link makes the first admin once", async () => {
  const { signIn } = server();
  const token = signIn.setupToken ?? "";
  const credentials = { name: " ana ", password: "a long password" };

  expect(await signIn.setUp("wrong", credentials)).toBeUndefined();

  expect(await signIn.setUp(token, credentials)).toMatchObject({
    name: "ana",
    admin: true,
  });

  expect(await signIn.setUp(token, credentials)).toBeUndefined();
  expect(signIn.setupToken).toBeUndefined();
});

test("the setup link stops working once someone has signed in another way", async () => {
  const { people, signIn } = server();
  const token = signIn.setupToken ?? "";

  people.createUser("ana", false);

  expect(
    await signIn.setUp(token, { name: "eve", password: "a long password" }),
  ).toBeUndefined();

  expect(signIn.setupToken).toBeUndefined();
  expect(people.users().map(({ name }) => name)).toEqual(["ana"]);
});

test("an invite lets one person in per email, and a link lets anyone in until it expires", async () => {
  const { people, signIn, time } = server();
  const [byEmail] = people.invite("ana", [" Bea@Example.com "], false, 7);
  const [link] = people.invite("ana", [], true, 1);
  const password = "a long password";

  expect(byEmail?.email).toBe("bea@example.com");
  expect(people.inviteFor(undefined, "BEA@example.com")?.id).toBe(byEmail?.id);

  expect(
    await signIn.joinWithInvite(byEmail?.token ?? "", {
      name: "bea",
      password,
    }),
  ).toMatchObject({ name: "bea", admin: false });

  expect(
    await signIn.joinWithInvite(byEmail?.token ?? "", {
      name: "cid",
      password,
    }),
  ).toBeUndefined();

  expect(
    await signIn.joinWithInvite(link?.token ?? "", { name: "bea", password }),
  ).toBe("taken");

  expect(
    await signIn.joinWithInvite(link?.token ?? "", { name: "cid", password }),
  ).toMatchObject({ admin: true });

  time.advance(24 * 60 * 60_000);

  expect(
    await signIn.joinWithInvite(link?.token ?? "", { name: "dan", password }),
  ).toBeUndefined();

  expect(people.invites()).toEqual([]);
});

test("locks a name after ten wrong passwords from one address, for that address only", async () => {
  const { signIn, time } = server();

  await signIn.setUp(signIn.setupToken ?? "", {
    name: "ana",
    password: "a long password",
  });

  for (let i = 0; i < 10; i++) {
    expect(
      await signIn.signIn({ name: "ana", password: "wrong one" }, "10.0.0.1"),
    ).toBe("wrong");
  }

  const right = { name: "ana", password: "a long password" };

  expect(await signIn.signIn(right, "10.0.0.1")).toBe("locked");
  expect(await signIn.signIn(right, "10.0.0.2")).toMatchObject({ name: "ana" });

  time.advance(16 * 60_000);

  expect(await signIn.signIn(right, "10.0.0.1")).toMatchObject({ name: "ana" });
});

test("a browser session cookie signs in until it ends", async () => {
  const { signIn } = server();

  const user = await signIn.setUp(signIn.setupToken ?? "", {
    name: "ana",
    password: "a long password",
  });

  const cookie = cookieOf(
    signIn.startSession(user ?? { id: "", name: "", admin: false }, request()),
  );

  expect(signIn.userOf(request(cookie))?.name).toBe("ana");

  signIn.endSession(request(cookie));

  expect(signIn.userOf(request(cookie))).toBeUndefined();
});

test("a solo install has one user, signed in through one-time links", () => {
  const { people, signIn, time } = server({ solo: "pedro" });
  const link = signIn.link();

  expect(() => people.createUser("ana", false)).toThrow(InvalidCredentials);
  expect(signIn.passwordLogin).toBe(false);
  expect(signIn.redeemLink(link)?.name).toBe("pedro");
  expect(signIn.redeemLink(link)).toBeUndefined();

  const late = signIn.link();
  time.advance(11 * 60_000);

  expect(signIn.redeemLink(late)).toBeUndefined();
});

test("an app link works only with the verifier of its challenge", () => {
  const { people, signIn } = server();
  const user = people.createUser("ana", false);
  const verifier = "a verifier the app keeps to itself";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const stolen = signIn.appLink(
    user ?? { id: "", name: "", admin: false },
    challenge,
  );

  const kept = signIn.appLink(
    user ?? { id: "", name: "", admin: false },
    challenge,
  );

  expect(signIn.redeemLink(stolen)).toBeUndefined();
  expect(signIn.redeemLink(kept, verifier)?.name).toBe("ana");
});

test("an access token acts as its user until revoked", () => {
  const { people } = server();
  const user = people.createUser("ana", false);
  const { token, secret } = people.newAccessToken(user?.id ?? "", " laptop ");

  const bearer = new Request("http://localhost/", {
    headers: { authorization: `Bearer ${secret}` },
  });

  expect(token.name).toBe("laptop");
  expect(people.userOfAccessToken(bearer)?.name).toBe("ana");
  expect(people.revokeAccessToken("someone else", token.id)).toBe(false);
  expect(people.revokeAccessToken(user?.id ?? "", token.id)).toBe(true);
  expect(people.userOfAccessToken(bearer)).toBeUndefined();

  expect(() => people.newAccessToken(user?.id ?? "", " ")).toThrow(
    InvalidCredentials,
  );
});

test("a person's email is an address no one else has, and clearing it takes it off", () => {
  const { people } = server();
  const ana = people.createUser("ana", false)?.id ?? "";
  const bea = people.createUser("bea", false)?.id ?? "";

  expect(
    people.changeAccount(ana, {
      displayName: "Ana",
      email: " ana@example.com ",
    }),
  ).toMatchObject({ displayName: "Ana", email: "ana@example.com" });

  expect(() =>
    people.changeAccount(bea, { displayName: "Bea", email: "ANA@example.com" }),
  ).toThrow("ANA@example.com is someone else's email");

  expect(() => people.changeAccount(bea, { email: "bea" })).toThrow(
    "bea isn't an email address",
  );

  // A refused change changes nothing.
  expect(people.changeAccount(bea, {})).toMatchObject({
    displayName: null,
    email: null,
  });

  expect(people.changeAccount(ana, { email: "" })).toMatchObject({
    email: null,
  });

  expect(people.changeAccount(bea, { email: "ana@example.com" })).toMatchObject(
    { email: "ana@example.com" },
  );
});

test("a person's username is a handle no one else has or goes by, and clearing it takes it off", () => {
  const { people } = server();
  const ana = people.createUser("ana@example.com", false)?.id ?? "";
  const bea = people.createUser("bea", false)?.id ?? "";

  expect(people.changeAccount(ana, { username: " Ana.Silva " })).toMatchObject({
    username: "ana.silva",
  });

  expect(people.users().find((each) => each.id === ana)).toMatchObject({
    username: "ana.silva",
  });

  expect(() => people.changeAccount(bea, { username: "ANA.SILVA" })).toThrow(
    "@ana.silva is someone else's",
  );

  expect(() => people.changeAccount(ana, { username: "bea" })).toThrow(
    "@bea is someone else's",
  );

  expect(() => people.changeAccount(bea, { username: "pipoca" })).toThrow(
    "@pipoca is taken",
  );

  expect(() => people.changeAccount(bea, { username: "bea lee" })).toThrow(
    "A username has 2 to 32 letters, digits, dots, dashes or underscores",
  );

  expect(people.changeAccount(ana, { username: "" })).toMatchObject({
    username: null,
  });

  expect(people.changeAccount(bea, { username: "ana.silva" })).toMatchObject({
    username: "ana.silva",
  });
});
