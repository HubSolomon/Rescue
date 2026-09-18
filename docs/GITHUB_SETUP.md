# GitHub Connection and Commit Guide

## 1. Create the repository

Create a private empty repository named `rescue-circular-logistics`. Do not add a README or `.gitignore in GitHub because they already exist locally.

## 2. Configure identity

```bash
git config user.name "Solomon Adjei"
git config user.email "YOUR_GITHUB_EMAIL"
```

## 3. Connect using SSH

```bash
git remote add origin git@github.com:YOUR_GITHUB_USERNAME/rescue-circular-logistics.git
git branch -M main
git push -u origin main
```

If SSH is not configured, use the GitHub CLI:

```bash
gh auth login
gh repo create rescue-circular-logistics --private --source=. --remote=origin --push
```

## 4. Claude workflow

```bash
git checkout -b claude/audit-foundation
claude
```

Tell Claude to read `docs/CLAUDE_BUILD_AND_AUDIT_PROMPT.md` and execute Phase 1 only. Review the audit before allowing implementation.

## 5. Pull-request workflow

```bash
git push -u origin claude/audit-foundation
gh pr create --base main --head claude/audit-foundation --title "Audit RESCUE foundation" --body "Architecture and security audit before backend implementation."
```

Never ask Claude to push directly to `main`. Require pull requests and passing checks.
