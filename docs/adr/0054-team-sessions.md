# 0054: Team Sessions

- Status: accepted, direction only (nothing is built until its prerequisites below are settled)
- Date: 2026-11-01

## Context

Pipoca is for one person or a team of about 10 to 15 people ([ADR 0053](0053-ways-to-run-pipoca.md)). Multiplayer, several people working in one Session, Project or plugin feature, was postponed ([open-questions.md](../open-questions.md#explicitly-postponed)) and placed in v3 ([vision.md](../vision.md#v3-a-teams-control-center)).

Today every Session is one person's. It runs with its starter's model logins, MCP sign-ins and git token ([ADR 0043](0043-git-hosts.md), [ADR 0045](0045-server-kept-logins.md)), on a runner only that person uses ([ADR 0049](0049-personal-environments-and-templates.md)). Sharing a Session as it is would spend one person's model quota on another's prompts and push with one person's token on another's behalf.

How other products handle this was researched before deciding (2026-11-01, 24 products):

- Team places act as a bot that an admin sets up and the organization pays for; personal places act as the person. Anthropic's Claude Tag runs channel sessions on admin-provisioned service accounts and a GitHub App, anyone in the channel can steer, and a direct message runs on the person's own account ([agent identity](https://claude.com/docs/claude-tag/concepts/agent-identity), [how it works](https://claude.com/docs/claude-tag/concepts/how-it-works)). Cursor's automations run as the person or as a service account ([automations](https://cursor.com/docs/cloud-agent/automations)). Devin opens PRs through an organization GitHub App by default ([GitHub integration](https://docs.devin.ai/it/integrations/gh.md)).
- The bot is the git author and the person is credited: Copilot and Cursor add the requester as `Co-authored-by`, and Copilot stops the requester from approving the agent's PR ([risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)).
- No product runs two turns at once in one session. Products that let several people steer queue messages and apply each after the current step, and a stop is posted with the person's name.
- Credentials stay out of the sandbox, injected at a proxy or stripped before the agent runs ([Claude Tag security](https://www.claude.com/docs/claude-tag/concepts/security-and-data), [Codex environments](https://learn.chatgpt.com/docs/environments/cloud-environment)).
- Roles stay small: viewer, participant or editor, owner or admin.
- Shared runners let sessions see each other's files ([Amp shared runners](https://ampcode.com/news/shared-runners)), and personal memory is turned off in group chats ([ChatGPT group chats](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)).

## Decision

### Team Sessions and team features belong to the team

- Multiplayer things are Team Sessions and team features, owned by a team rather than a person (decided 2026-11-01). A Session's owner is a person or a team, and the kernel knows both.
- A team thing runs on credentials an admin sets up: a model key, and a GitHub App or bot account. It runs on a team Profile and in team Environments. It never uses a member's own logins, Profile, memory or skills (decided 2026-11-01).
- Team runners only host team Sessions, and personal runners only host personal ones, so ADR 0049's rule still holds: one person's credentials never share a machine with anyone else's. Every team Session still gets its own container and Workspace, so team Sessions don't read each other's files.
- Credentials resolve from the Session's owner, never from the person who sent the message. A member can't bring their own login into a Team Session for now (decided 2026-11-01). They move work between the two instead: "move to team" and "fork to personal" start the Session over on the other side, with a fresh Workspace, as a fork does today ([ADR 0034](0034-v2-deployment-and-credentials.md#v2-scope)). A member's own login for their own messages, approved by them and run outside the team's runners, can be reconsidered once Team Sessions have users.

### The kernel decides who sees and steers

- Who can see a team thing, who can steer it, and which credentials it uses are kernel decisions, denied unless granted. A plugin declares what it shares and what it needs; it doesn't decide it.
- Roles are viewer, participant and owner, granted to people or to the whole team.
- Every message, tool call and change carries its actor, and "on behalf of" when an agent acts for a person. ADR 0015's actors already record who did what; Team Sessions show it.
- Each Session has one input queue, run by the kernel. A message is checked against the sender's role when it is queued and applies after the current step. Any participant can stop the Session, and the stop is posted with their name. Presence, who is looking and who is typing, is a separate live channel that keeps nothing.

### What must exist before Team Sessions are built

- **A Pipoca GitHub App**, designed in its own decision: per-Session installation tokens scoped to the Session's repositories, the bot as author with the person as `Co-authored-by`, and the person who asked unable to approve the PR it opens.
- **Credentials outside the Session.** The team's model key is used through the server or a proxy, not put in the runner's environment, so a team member, or text the agent reads, can't copy it. This brings forward part of brokered secrets, which [ADR 0034](0034-v2-deployment-and-credentials.md#v2-scope) left for later.
- **A usage and audit record**: one row per model call and per credential use, keyed by owner, actor, model and credential, with team budgets, a cap per person, and an export for admins. This brings forward part of v3's quotas and audit trails.
- **Team membership**: admins say who is in the team and what the team's credentials can reach.

## Consequences

- Personal Sessions keep working exactly as they do; nothing about a person's credentials changes.
- A shared model key or GitHub App can't be leaked from a Team Session's environment, and every spend and push names the person who asked.
- Plugins can't share more than the kernel allows, so a plugin bug can't open a personal Session to the team.
- Two Sessions can't be steered at once by two people; a busy Session queues messages.
- A member who needs their own access in team work has to fork to a personal Session for now.
- Team Sessions wait on four other pieces of work: the GitHub App, brokered team credentials, the usage record and team membership.
- Pushes from Team Sessions show the bot as author, not the person.
