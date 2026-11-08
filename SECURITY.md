# Security

Pipoca runs coding agents with access to code, credentials and shells, so security reports matter a lot.

## Reporting a vulnerability

Please report it privately through [GitHub's private vulnerability reporting](https://github.com/PedroKlein/pipoca/security/advisories/new), not in a public issue. Say what an attacker can do, the version or commit you tested, and the steps to reproduce it.

Fixes go into the next release, and the advisory is published once a fixed release is out.

## Supported versions

Only the latest release, and `main`, get security fixes.

## What Pipoca does and doesn't protect

- A team server keeps each person's Sessions, transcripts, logins and runners apart. Admins see an outline of everyone's work, never transcripts or secrets.
- Secrets and logins are sealed with the server's key. Anyone with the key and the database can read them.
- A plugin runs with the server's own access, and nothing sandboxes it. Turn on only plugins you trust.
- A Session runs Pi with the tools its Profile gives it, on its runner. Pi can do what its runner's user can do there.
- Artifacts run in a sandbox on an opaque origin, without access to Pipoca or your sign-in.
