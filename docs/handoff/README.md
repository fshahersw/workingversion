# Agent handoff protocol

Two Claude surfaces work this repo. Coordinate through git + the two files in
this directory, never through copy-pasted chat.

## The two roles

- **Desktop dev agent** (`lit-ai-main` session, Claude Code in Bedrock 3P mode):
  primary builder. Can edit files, run shell/bun, invoke Bedrock + AgentCore.
  Its AWS shell is **inference-only** — no DynamoDB/S3 writes, no IAM.
- **CLI executor** (terminal Claude Code): runs under Firas's admin SSO profile.
  Used for anything the desktop can't do: privileged AWS (DynamoDB/S3 reads or
  writes, IAM/Identity Center), and reviewing/running changes with admin creds.

## Flow

1. Desktop does its work on a **branch** and commits it.
2. When it needs a privileged action or a review, it writes `REQUEST.md` (schema
   below) and commits.
3. Firas tells the CLI executor: **"check handoff."**
4. CLI executor reads the branch diff + `REQUEST.md`, performs only what's asked,
   writes `RESULT.md` with command output and pass/fail, and commits.
5. Firas tells the desktop: **"read RESULT.md."** Repeat.

Firas is the approval gate for every privileged/mutating action. The executor
proposes; Firas approves; then it runs.

## Rules

- **No secrets in these files.** No `.env` values, tokens, or keys. Reference the
  variable name, not its value.
- **IAM / Identity Center / SSO changes are Firas's to run**, not either agent's.
  The executor writes the exact policy/steps into `RESULT.md`; Firas applies them.
- Reference code by commit SHA and `path:line`, never by pasting large diffs.
- One request open at a time. Clear `REQUEST.md`/`RESULT.md` (or archive under
  `docs/handoff/archive/`) when a cycle closes.

## REQUEST.md schema

```
# REQUEST <short title>
- branch: <branch name> @ <sha>
- task: <one line>
- why: <one line>
- do: <exact commands or edits to run>
- expect: <what success looks like>
- verify: <how the executor should confirm it worked>
```

## RESULT.md schema

```
# RESULT <short title> — <ok | failed | partial>
- ran: <what was executed>
- output: <key output, trimmed; no secrets>
- outcome: <pass/fail + numbers>
- follow-up: <anything Firas or the desktop must do next>
```
