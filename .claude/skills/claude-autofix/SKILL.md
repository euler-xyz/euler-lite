---
name: claude-autofix
description: Read open review feedback on the current PR and implement fixes directly in the codebase
---

# Auto-fix PR Review Comments

Read all open review feedback on the current PR and implement fixes directly in the codebase.

## Instructions

### Step 1: Gather all review feedback

```bash
# Inline review comments (line-specific)
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/comments" \
  --jq '.[] | {id: .id, path: .path, line: .line, body: .body, user: .user.login}'

# Review summaries (overall assessments)
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select(.state != "DISMISSED") | {id: .id, state: .state, body: .body, user: .user.login}'

# General PR comments
gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \
  --jq '.[] | {id: .id, body: .body, user: .user.login}'
```

### Step 2: Triage feedback — be conservative

For each piece of feedback, **read the actual code at the referenced location first**, then decide:

**Implement only if ALL of the following are true:**
1. The issue actually exists in the code (verify by reading the file — don't trust the review blindly)
2. The correct fix is unambiguous — there is one obvious, safe resolution
3. The fix is self-contained and does not require understanding a product or UX decision
4. No human reviewer has pushed back on or disagreed with this finding

**Skip — and note in summary — if any of the following apply:**
- The flagged code looks correct after reading it in context (false positive)
- The fix would change observable behaviour beyond what the comment describes
- Multiple reviewers contradict each other on this point
- The fix requires a product decision ("should this round up or down?")
- It's a question, a `💬 SUGGESTION:`, or a style preference
- You are not confident the original finding was correct

**When in doubt, skip it.** A skipped item costs the author 30 seconds to review. A bad auto-fix costs everyone much more.

### Step 3: Implement fixes

Read the relevant files, make the fixes. Follow the existing code patterns — don't refactor surrounding code.

For each fix:
1. Read the file at the referenced path
2. Understand the context
3. Apply the minimal change that resolves the feedback
4. Do not "improve" surrounding code beyond what was requested

### Step 4: Commit

Stage only the specific files you edited — never `git add .` or `git add -A`:

```bash
# Stage each file you modified explicitly
git add composables/repay/useWalletRepay.ts utils/fixed-point.ts
git status  # verify only intended files are staged before committing
git commit -m "fix: address PR review comments"
git push origin HEAD
```

If there are multiple logical groups of fixes (e.g. stack hygiene vs business logic), split into separate commits, staging the relevant files for each:

```bash
git add composables/repay/useMaxRepay.ts
git commit -m "fix: correct bigint arithmetic in repay flow"

git add pages/position/index.vue
git commit -m "fix: resolve stack hygiene review findings"

git push origin HEAD
```

Always run `git status` before committing to confirm only the expected files are staged.

### Step 5: Post a summary comment

Write the summary to a temp file first, then post — do not use heredoc inside `$()` inside a quoted string (shell parsing failure):

```bash
cat > /tmp/autofix-summary.md << 'EOF'
## Auto-fix Summary

### Fixed
- [list each fix with file:line reference]

### Skipped
- [list each item skipped and why — question, contradiction, style preference, etc.]

If any skipped items need human input, please clarify and re-run `@claude fix`.
EOF

gh api "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \
  --method POST \
  -F body=@/tmp/autofix-summary.md
```

## Important Constraints

- Never commit secrets, `.env` files, or unrelated files
- Never force-push or amend commits — always create new commits
- If a fix would require understanding a product decision or changing behaviour beyond the review comment scope, skip it and note it in the summary
- If the same issue appears in multiple places but the review only flagged one, fix all occurrences (and note this in the summary)
