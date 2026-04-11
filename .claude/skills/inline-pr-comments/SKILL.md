---
name: inline-pr-comments
description: Submit code review findings as a single consolidated GitHub PR review with inline comments via gh api
---

# Consolidated PR Review Skill

Use this skill to submit code review feedback as a **single consolidated GitHub review** containing both the summary body and all inline comments.

## When to Use

- After completing any code review (use with /claude-review-stack, /claude-review-business, /claude-review-security)
- When you have specific line-by-line feedback to deliver

## Instructions

Submit one consolidated review per run using the GitHub API. **Do NOT post inline comments individually.** Each run produces a new review — nothing is overwritten.

### Step 1: Fetch Prior Review Context

Before posting, read existing reviews and comments on the PR to avoid duplication:

```bash
# Fetch existing reviews (summaries)
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews" --jq '.[] | {user: .user.login, state: .state, body: .body}'

# Fetch inline review comments
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/comments" --jq '.[] | {user: .user.login, path: .path, line: .line, body: .body}'

# Fetch general PR discussion comments
gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" --jq '.[] | {user: .user.login, body: .body}'
```

Use this context to:
- **Skip issues already raised** — don't re-flag something a prior review already pointed out
- **Flag unresolved issues** — if a prior review raised something that still isn't fixed, note it briefly
- **Avoid contradictions** — don't suggest the opposite of what a human reviewer requested

### Step 2: Collect All Findings

Complete the full review. Collect:
- **Summary** — Overall assessment, architecture concerns, non-diff observations, CRITICAL issue count
- **Inline comments** — Specific issues on changed lines (path, line, body)

Mark each finding with a severity prefix:
- `🔴 Critical:` — must be fixed before merge (incorrect logic, security issue, data loss risk)
- `🟠 Major:` — should be fixed but won't block merge (bad pattern, fragile code)
- `🧹 Nitpick:` — optional improvement (style, minor optimisation)

### Step 3: Build Review JSON

Write a JSON file to `/tmp/review.json`:

```json
{
  "body": "## Review Summary\n\nOverall assessment here.\n\n**Critical issues: N**\n\n## Observations Outside This PR\n- `file:line`: description",
  "event": "COMMENT",
  "comments": [
    {
      "path": "composables/repay/useWalletRepay.ts",
      "line": 42,
      "body": "🔴 Critical: Issue description here"
    },
    {
      "path": "utils/fixed-point.ts",
      "start_line": 10,
      "line": 15,
      "side": "RIGHT",
      "body": "🟠 Major: Multi-line comment"
    }
  ]
}
```

**Fields:**
- `body` — Markdown review summary (required), must include critical issue count
- `event` — Always `"COMMENT"` (never APPROVE or REQUEST_CHANGES)
- `comments` — Array of inline comment objects (can be empty)
  - `path` — File path relative to repo root
  - `line` — Line number in the **NEW** version of the file
  - `start_line` + `line` + `side: "RIGHT"` — For multi-line comments on added/changed lines
  - `body` — Markdown-formatted feedback with severity prefix

### Step 4: Submit the Review

```bash
gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews" --input /tmp/review.json
```

If the API call fails (e.g. a comment targeted an unchanged line causing a 422), note the error in a follow-up PR comment and stop.

### Limitations

- Inline comments can only target lines in the diff (changed/added lines)
- Comments targeting unchanged lines will cause the API call to fail
- If unsure whether a line is in the diff, put the finding in the summary body instead

### Handling Non-Diff Findings

Issues in code NOT changed by the PR go in the review `body`:

```markdown
## Observations Outside This PR

- `composables/useEulerAccount.ts:142`: Pre-existing null check missing
- `utils/fixed-point.ts:78-82`: Similar pattern to line 45 issue
```

### Feedback Guidelines

| Feedback Type | In Diff? | Where |
|---|---|---|
| Specific code issue | Yes | `comments` array |
| Pattern repeated across files | Yes | First in `comments` + note others in body |
| Related issue found | No | `body` under "Observations Outside This PR" |
| Pre-existing bug | No | `body` (consider separate issue if critical) |
| Overall architecture concern | N/A | `body` |

Be concise. Group minor style issues together. Never use APPROVE or REQUEST_CHANGES.
