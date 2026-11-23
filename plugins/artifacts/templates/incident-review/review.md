---
doc: design
status: draft
---

# Incident review: what broke, and when

**Incident:** the alert or ticket · **Severity:** its level · **Reviewers:** who reviews it

## Summary

What happened, who was affected and for how long, in three sentences.

## Impact

- **Who:** the users, customers or teams affected, and how many.
- **How long:** from the first effect to full recovery.
- **What they saw:** errors, slowness or lost data.

## Timeline (UTC)

| Time (UTC)       | What happened                        | Source             |
| ---------------- | ------------------------------------ | ------------------ |
| YYYY-MM-DD HH:MM | The first sign, such as an alert     | A link to it       |
| YYYY-MM-DD HH:MM | Someone starts looking               | A link to the chat |
| YYYY-MM-DD HH:MM | The cause is found                   | A link             |
| YYYY-MM-DD HH:MM | The fix ships and the effect is gone | A link             |

## What happened

How the system got into this state, step by step, without naming anyone as at fault.

## Findings

1. A finding, as a sentence. Evidence: a link to the commit, log query or dashboard.

## What went well

- What helped us find and fix it fast.

## Actions

| Action                     | Owner  | Due    |
| -------------------------- | ------ | ------ |
| Something to do, as a verb | A name | A date |
