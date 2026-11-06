# 0070: Schema migrations

- Status: accepted
- Date: 2026-11-06

## Context

The clean rebuild ([ADR 0068](0068-clean-rebuild.md#storage)) started from a fresh database with no migration history. It recorded a hash of each owner's schema, refused a database whose kernel schema differed, and failed a plugin whose schema changed until an admin reset its data. Any edit, even a comment, broke an existing database, and nothing upgraded in place. Kyma will soon run with data that must survive upgrades.

## Decision

- The kernel's schema and each plugin's declared `schema` stay as they are, as version 0. Each gains an optional ordered list of `migrations`, plain SQL; migration n brings the tables to version n.
- `schema_owners` records each owner's version instead of a hash.
- A new database runs each baseline and then all its migrations, so there is one path. An existing database runs the migrations it hasn't, in order, inside the transaction the server opens the database in, and records the new version.
- A database whose kernel is at a higher version than the code knows, such as after a downgrade, refuses to start and says so. A plugin at a higher version, or whose migration fails, fails with its data kept and rolled back, and an admin can reset its data on the Plugins page as before. Tables a migration makes are checked like the baseline's.
- A released baseline is never edited, since databases already hold it. A test pins each built-in baseline's hash and says to add a migration instead. The server compares no hash, so a comment changes nothing at runtime.

## Consequences

- This supersedes ADR 0068's "no migrations", the hash per owner and failing a plugin whose schema changed.
- Migrations only go forward. Going back to an older Pipoca means restoring a backup of the database.
- Migrations run inside a transaction, where `pragma foreign_keys` can't change. A migration that rebuilds a table uses `pragma defer_foreign_keys = on`.
