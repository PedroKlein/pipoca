import type { Invite, SetupState } from "@pipoca/protocol";
import type { AccessToken, PeopleStore, StoredUser } from "../people";

export function memoryStore(): PeopleStore {
  const users: StoredUser[] = [];
  const sessions = new Map<string, { userId: string; expiresAt: string }>();
  const invites = new Map<string, Invite & { tokenHash: string }>();
  const tokens = new Map<string, AccessToken>();
  const pinned = new Map<string, readonly string[] | null>();
  const setups = new Map<string, SetupState>();
  const defaults = new Map<string, string | null>();

  const named = new Map<string, string | null>();

  const user = (id: string | undefined) => {
    const found = users.find((each) => each.id === id);

    return found && { id: found.id, name: found.name, admin: found.admin };
  };

  const usable = (invite: Invite, now: string) =>
    invite.expiresAt > now && (invite.email === null || invite.uses === 0);

  return {
    userCount: () => users.length,
    userByName: (name) => users.find((each) => each.name === name),
    userById: user,
    users: () => users.flatMap(({ id }) => user(id) ?? []),
    account: (id) => {
      const found = users.find((each) => each.id === id);

      return (
        found && {
          id: found.id,
          name: found.name,
          admin: found.admin,
          displayName: named.has(id)
            ? (named.get(id) ?? null)
            : (found.displayName ?? null),
          defaultEnvironment: defaults.get(id) ?? null,
        }
      );
    },
    setDisplayName: (id, name) => {
      named.set(id, name);
    },
    setDefaultEnvironment: (id, environment) => {
      defaults.set(id, environment);
    },
    insertUser: (stored) => {
      users.push(stored);
    },
    setAdmin: (id, admin) => {
      const index = users.findIndex((each) => each.id === id);
      const found = users[index];

      if (found !== undefined) {
        users[index] = { ...found, admin };
      }
    },
    people: () =>
      users.map(({ id, name, admin }) => ({
        id,
        name,
        admin,
        settingUp: setups.get(id)?.finished !== true,
        lastActive: null,
      })),
    setLastActive: () => undefined,
    insertBrowserSession: (hash, userId, expiresAt) => {
      sessions.set(hash, { userId, expiresAt });
    },
    browserSessionUser: (hash, now) => {
      const session = sessions.get(hash);

      return session !== undefined && session.expiresAt > now
        ? user(session.userId)
        : undefined;
    },
    deleteBrowserSession: (hash) => {
      sessions.delete(hash);
    },
    deleteSignIns: (userId) => {
      for (const [hash, session] of sessions) {
        if (session.userId === userId) {
          sessions.delete(hash);
        }
      }

      for (const [id, token] of tokens) {
        if (token.userId === userId) {
          tokens.delete(id);
        }
      }
    },
    insertInvite: (invite, tokenHash) => {
      invites.set(invite.id, { ...invite, tokenHash });
    },
    invites: (now) =>
      [...invites.values()].filter((invite) => usable(invite, now)),
    inviteByToken: (hash, now) =>
      [...invites.values()].find(
        (invite) => invite.tokenHash === hash && usable(invite, now),
      ),
    inviteByEmail: (email, now) =>
      [...invites.values()].find(
        (invite) =>
          invite.email === email && invite.expiresAt > now && invite.uses === 0,
      ),
    deleteInvite: (id) => invites.delete(id),
    useInvite: (id) => {
      const invite = invites.get(id);

      if (invite === undefined || (invite.email !== null && invite.uses > 0)) {
        return false;
      }

      invites.set(id, { ...invite, uses: invite.uses + 1 });

      return true;
    },
    insertAccessToken: (token, hash) => {
      tokens.set(hash, token);
    },
    accessTokens: (userId) =>
      [...tokens.values()].filter((token) => token.userId === userId),
    accessTokenUser: (hash) => user(tokens.get(hash)?.userId),
    deleteAccessToken: (id, userId) => {
      const found = [...tokens].find(
        ([, token]) => token.id === id && token.userId === userId,
      );

      return found !== undefined && tokens.delete(found[0]);
    },
    pinnedPages: (userId) => pinned.get(userId) ?? null,
    setPinnedPages: (userId, pages) => {
      pinned.set(userId, pages);
    },
    setup: (userId) => setups.get(userId) ?? { finished: false, dismissed: [] },
    setSetup: (userId, state) => {
      setups.set(userId, state);
    },
  };
}
