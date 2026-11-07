import type { DatabaseSync } from "node:sqlite";
import type { Clock, Invite } from "@pipoca/protocol";
import type { PeopleStore, User } from "@pipoca/people";
import { transaction } from "./database";
import { iso, isoOrNull, ms } from "./rows";

interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly admin: number;
}

function userOfRow(row: UserRow | undefined): User | undefined {
  return row && { id: row.id, name: row.name, admin: row.admin === 1 };
}

interface InviteRow {
  readonly id: string;
  readonly email: string | null;
  readonly admin: number;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly expires_at: number;
  readonly uses: number;
}

function inviteOf(row: InviteRow): Invite {
  return {
    id: row.id,
    email: row.email,
    admin: row.admin === 1,
    createdBy: row.created_by ?? "",
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    uses: row.uses,
  };
}

export function peopleStore(db: DatabaseSync, clock: Clock): PeopleStore {
  const countUsers = db.prepare("select count(*) as n from users");

  const selectUser = db.prepare(
    "select id, name, password_hash, created_at, admin from users where name = ?",
  );

  const selectUserById = db.prepare(
    "select id, name, admin from users where id = ?",
  );

  const selectUsers = db.prepare(
    "select id, name, admin from users order by created_at",
  );

  const selectAccount = db.prepare(
    "select id, name, admin, display_name, default_environment_id from users where id = ?",
  );

  const updateDisplayName = db.prepare(
    "update users set display_name = ? where id = ?",
  );

  const updateDefaultEnvironment = db.prepare(
    "update users set default_environment_id = ? where id = ?",
  );

  const deleteBrowserSessions = db.prepare(
    "delete from browser_sessions where user_id = ?",
  );

  const deleteTokens = db.prepare(
    "delete from access_tokens where user_id = ?",
  );

  const insertUser = db.prepare(
    "insert into users (id, name, display_name, password_hash, created_at, admin) values (?, ?, ?, ?, ?, ?)",
  );

  const updateAdmin = db.prepare("update users set admin = ? where id = ?");

  const selectPeople = db.prepare(
    "select id, name, admin, setup_finished_at, last_active_at from users order by created_at",
  );

  const updateLastActive = db.prepare(
    "update users set last_active_at = ? where id = ?",
  );

  const insertBrowserSession = db.prepare(
    "insert into browser_sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)",
  );

  const selectBrowserSessionUser = db.prepare(
    "select users.id, users.name, users.admin from browser_sessions join users on users.id = browser_sessions.user_id where token_hash = ? and expires_at > ?",
  );

  const deleteBrowserSession = db.prepare(
    "delete from browser_sessions where token_hash = ?",
  );

  const deleteExpired = db.prepare(
    "delete from browser_sessions where expires_at <= ?",
  );

  const insertInvite = db.prepare(
    "insert into invites (id, token_hash, email, admin, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
  );

  const inviteColumns =
    "select id, email, admin, created_by, created_at, expires_at, uses from invites";

  // An invite with an email is used up once someone joins with it.
  const selectInvites = db.prepare(
    `${inviteColumns} where expires_at > ? and (email is null or uses = 0) order by created_at`,
  );

  const selectInviteByToken = db.prepare(
    `${inviteColumns} where token_hash = ? and expires_at > ? and (email is null or uses = 0)`,
  );

  const selectInviteByEmail = db.prepare(
    `${inviteColumns} where email = ? and expires_at > ? and uses = 0 order by created_at desc`,
  );

  const deleteInvite = db.prepare("delete from invites where id = ?");

  const useInvite = db.prepare(
    "update invites set uses = uses + 1 where id = ? and (email is null or uses = 0)",
  );

  const insertToken = db.prepare(
    "insert into access_tokens (id, token_hash, user_id, name, created_at) values (?, ?, ?, ?, ?)",
  );

  const selectPinnedAt = db.prepare("select pinned_at from users where id = ?");

  const selectPinnedPages = db.prepare(
    "select page from user_pinned_pages where user_id = ? order by position",
  );

  const updatePinnedAt = db.prepare(
    "update users set pinned_at = ? where id = ?",
  );

  const deletePinnedPages = db.prepare(
    "delete from user_pinned_pages where user_id = ?",
  );

  const insertPinnedPage = db.prepare(
    "insert into user_pinned_pages (user_id, position, page) values (?, ?, ?)",
  );

  const selectSetupFinished = db.prepare(
    "select setup_finished_at from users where id = ?",
  );

  const selectDismissed = db.prepare(
    "select step from user_dismissed_steps where user_id = ? order by rowid",
  );

  const updateSetupFinished = db.prepare(
    "update users set setup_finished_at = case when ?1 then coalesce(setup_finished_at, ?2) end where id = ?3",
  );

  const selectServerSetup = db.prepare("select 1 from server_setup");

  const insertServerSetup = db.prepare(
    "insert or ignore into server_setup (id, finished_at, finished_by) values (1, ?, ?)",
  );

  const deleteDismissed = db.prepare(
    "delete from user_dismissed_steps where user_id = ?",
  );

  const insertDismissed = db.prepare(
    "insert or ignore into user_dismissed_steps (user_id, step) values (?, ?)",
  );

  const selectTokens = db.prepare(
    "select id, name, created_at from access_tokens where user_id = ? order by created_at",
  );

  const selectTokenUser = db.prepare(
    "select users.id, users.name, users.admin from access_tokens join users on users.id = access_tokens.user_id where token_hash = ?",
  );

  const deleteToken = db.prepare(
    "delete from access_tokens where id = ? and user_id = ?",
  );

  return {
    userCount: () => (countUsers.get() as { n: number }).n,
    userByName: (name) => {
      const row = selectUser.get(name) as
        | {
            id: string;
            name: string;
            password_hash: string | null;
            created_at: number;
            admin: number;
          }
        | undefined;

      return (
        row && {
          id: row.id,
          name: row.name,
          admin: row.admin === 1,
          passwordHash: row.password_hash ?? "",
          createdAt: iso(row.created_at),
        }
      );
    },
    userById: (id) => userOfRow(selectUserById.get(id) as UserRow | undefined),
    users: () =>
      (selectUsers.all() as unknown as UserRow[]).flatMap(
        (row) => userOfRow(row) ?? [],
      ),
    account: (id) => {
      const row = selectAccount.get(id) as
        | (UserRow & {
            readonly display_name: string | null;
            readonly default_environment_id: string | null;
          })
        | undefined;

      return (
        row && {
          id: row.id,
          name: row.name,
          admin: row.admin === 1,
          displayName: row.display_name,
          defaultEnvironment: row.default_environment_id,
        }
      );
    },
    setDisplayName: (id, name) => {
      updateDisplayName.run(name, id);
    },
    setDefaultEnvironment: (id, environment) => {
      updateDefaultEnvironment.run(environment, id);
    },
    insertUser: (user) => {
      insertUser.run(
        user.id,
        user.name,
        user.displayName ?? null,
        user.passwordHash === "" ? null : user.passwordHash,
        ms(user.createdAt),
        user.admin ? 1 : 0,
      );
    },
    setAdmin: (id, admin) => {
      updateAdmin.run(admin ? 1 : 0, id);
    },
    people: () =>
      (
        selectPeople.all() as unknown as (UserRow & {
          readonly setup_finished_at: number | null;
          readonly last_active_at: number | null;
        })[]
      ).map((row) => ({
        id: row.id,
        name: row.name,
        admin: row.admin === 1,
        settingUp: row.setup_finished_at === null,
        lastActive: isoOrNull(row.last_active_at),
      })),
    setLastActive: (id, at) => {
      updateLastActive.run(ms(at), id);
    },
    insertBrowserSession: (tokenHash, userId, expiresAt) => {
      const now = clock.now();
      deleteExpired.run(now);
      insertBrowserSession.run(tokenHash, userId, now, ms(expiresAt));
    },
    browserSessionUser: (tokenHash, now) =>
      userOfRow(
        selectBrowserSessionUser.get(tokenHash, ms(now)) as UserRow | undefined,
      ),
    deleteBrowserSession: (tokenHash) => {
      deleteBrowserSession.run(tokenHash);
    },
    deleteSignIns: (userId) => {
      transaction(db, () => {
        deleteBrowserSessions.run(userId);
        deleteTokens.run(userId);
      });
    },
    insertInvite: (invite, tokenHash) => {
      insertInvite.run(
        invite.id,
        tokenHash,
        invite.email,
        invite.admin ? 1 : 0,
        invite.createdBy,
        ms(invite.createdAt),
        ms(invite.expiresAt),
      );
    },
    invites: (now) =>
      (selectInvites.all(ms(now)) as unknown as InviteRow[]).map(inviteOf),
    inviteByToken: (tokenHash, now) => {
      const row = selectInviteByToken.get(tokenHash, ms(now)) as
        InviteRow | undefined;

      return row && inviteOf(row);
    },
    inviteByEmail: (email, now) => {
      const row = selectInviteByEmail.get(email, ms(now)) as
        InviteRow | undefined;

      return row && inviteOf(row);
    },
    deleteInvite: (id) => deleteInvite.run(id).changes > 0,
    useInvite: (id) => useInvite.run(id).changes > 0,
    insertAccessToken: (token, tokenHash) => {
      insertToken.run(
        token.id,
        tokenHash,
        token.userId,
        token.name,
        ms(token.createdAt),
      );
    },
    accessTokens: (userId) =>
      (
        selectTokens.all(userId) as {
          id: string;
          name: string;
          created_at: number;
        }[]
      ).map((row) => ({
        id: row.id,
        userId,
        name: row.name,
        createdAt: iso(row.created_at),
      })),
    accessTokenUser: (tokenHash) =>
      userOfRow(selectTokenUser.get(tokenHash) as UserRow | undefined),
    deleteAccessToken: (id, userId) =>
      Number(deleteToken.run(id, userId).changes) > 0,
    pinnedPages: (userId) => {
      const row = selectPinnedAt.get(userId) as
        { pinned_at: number | null } | undefined;

      return row === undefined || row.pinned_at === null
        ? null
        : (selectPinnedPages.all(userId) as { page: string }[]).map(
            ({ page }) => page,
          );
    },
    setPinnedPages: (userId, pages) => {
      transaction(db, () => {
        updatePinnedAt.run(pages === null ? null : clock.now(), userId);
        deletePinnedPages.run(userId);

        pages?.forEach((page, position) => {
          insertPinnedPage.run(userId, position, page);
        });
      });
    },
    setup: (userId) => {
      const row = selectSetupFinished.get(userId) as
        { setup_finished_at: number | null } | undefined;

      return {
        finished: row !== undefined && row.setup_finished_at !== null,
        dismissed: (selectDismissed.all(userId) as { step: string }[]).map(
          ({ step }) => step,
        ),
      };
    },
    serverSetupFinished: () => selectServerSetup.get() !== undefined,
    finishServerSetup: (userId) => {
      insertServerSetup.run(clock.now(), userId);
    },
    setSetup: (userId, state) => {
      transaction(db, () => {
        updateSetupFinished.run(state.finished ? 1 : 0, clock.now(), userId);
        deleteDismissed.run(userId);

        for (const step of state.dismissed) {
          insertDismissed.run(userId, step);
        }
      });
    },
  };
}
