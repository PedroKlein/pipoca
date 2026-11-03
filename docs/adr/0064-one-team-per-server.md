# 0064: One team per server

- Status: accepted
- Date: 2026-11-03

## Context

v3 turns Pipoca into a place where a team works ([vision.md](../vision.md#v3-a-teams-control-center)). [ADR 0054](0054-team-sessions.md) set the direction for Team Sessions: owned by a team, run on credentials an admin sets up, and never on a member's own logins. It left open what a team is, and listed team membership as one of four things to settle before Team Sessions are built.

Some of it already exists. Single sign-on decides who becomes a user and who is an admin through the provider's groups ([ADR 0038](0038-single-sign-on-and-admins.md)). Every Environment, runner and Session is one person's, and admins share templates that people copy ([ADR 0049](0049-personal-environments-and-templates.md)). Admins offer Profiles that a new member copies, and the base Profile can carry a team's API key ([ADR 0063](0063-settings-and-first-run-setup.md)). Pipoca is for one person or a team of about 10 to 15 ([ADR 0053](0053-ways-to-run-pipoca.md)).

## Decision

### A server is one team

- A Pipoca server serves exactly one team. It never holds several teams, and two teams run two servers (decided 2026-11-03).
- The team is the server's users. Who is in it is decided where it is today: the sign-in provider's access group, or the password users an admin creates. There's no separate membership list.
- There are two roles: admins and users (decided 2026-11-03). Admins manage the server and everything the team owns. Users use it.
- A record's owner is a person or the team. ADR 0054's "a person or a team" means the server's one team.

### Team work is open to the team

- Every user can see and steer a team Session or Project by default (decided 2026-11-03).
- Whoever started it, or an admin, can make it view-only for everyone else, or limit it to named people. That replaces ADR 0054's per-Session viewer, participant and owner grants with one default and one restriction.
- Every user can start team Sessions, Projects and routines (decided 2026-11-03). Spend is held by the team budgets and per-person caps of the usage record ADR 0054 asks for, not by a second list of who may start team work.

### The team has its own Profiles and Environments

- Team Sessions run on team Profiles: Profiles the team owns, that build on the base, and that admins manage (decided 2026-11-03). The starter picks one. A user's My defaults, personal Profiles and personal logins never load in team work.
- A team Profile uses only logins on the base or on team Profiles.
- The team has its own Environments, managed by admins (decided 2026-11-03). Their runners host only team Sessions, and personal runners only personal ones, so one person's credentials still never share a machine with anyone else's ([ADR 0049](0049-personal-environments-and-templates.md)).
- These are different from what admins share today. A Profile on offer ([ADR 0063](0063-settings-and-first-run-setup.md#joining-a-team)) and an Environment template ([ADR 0049](0049-personal-environments-and-templates.md)) are copied into something a person owns. A team Profile and a team Environment stay the team's: users use them and can't change them.

### The team gets its own view

- Team work has a view of its own, apart from a person's own Sessions, Projects and Settings (decided 2026-11-03). What it looks like is decided from mockups of a few directions before anything is built.

## Consequences

- Membership needs no new flow: the sign-in provider's groups or the admin's password users already decide it. ADR 0054's membership prerequisite comes down to what the team's credentials can reach.
- Roles stay at admin and user, so a team that needs a third role, such as people who may only watch, can't have one yet.
- Anyone on the team can read team work unless its starter limits it, so sensitive work belongs in personal Sessions or a limited team Session.
- A team runner holds team credentials and every user can steer the Sessions on it, which makes keeping credentials outside the Session the next thing to design.
- Admins look after a second set of Profiles and Environments, the team's, next to the base, the Profiles on offer and the templates.
- Team screens can't simply reuse the personal pages with a Team section added, so they cost more to design and build.
- Two teams on one cluster run two servers, each with its own database, sign-in and admins.
