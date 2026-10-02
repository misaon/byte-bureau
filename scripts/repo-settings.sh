#!/usr/bin/env bash
# Owner-run: configures the GitHub repository (features, security, labels, rulesets).
# Usage: scripts/repo-settings.sh <owner>/<repo> [--dry-run]
set -euo pipefail

REPO="${1:?usage: repo-settings.sh <owner>/<repo> [--dry-run]}"
MODE="${2:-}"

run() {
  if [ "$MODE" = "--dry-run" ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

run gh repo edit "$REPO" \
  --description "The AI office: orchestrate coding agents in a pixel-art bureau" \
  --homepage "https://misaon.github.io/byte-bureau/" \
  --enable-wiki=false --enable-projects=false --enable-discussions \
  --enable-merge-commit=false --enable-rebase-merge=false --enable-squash-merge \
  --delete-branch-on-merge --allow-update-branch --enable-auto-merge \
  --add-topic ai-agents --add-topic coding-agents --add-topic multi-agent --add-topic developer-tools \
  --add-topic typescript --add-topic bun --add-topic docker --add-topic pixel-art --add-topic fair-source --add-topic fsl

run gh api -X PATCH "repos/${REPO}" \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY \
  -F web_commit_signoff_required=true
run gh api -X PUT "repos/${REPO}/vulnerability-alerts"
run gh api -X PUT "repos/${REPO}/automated-security-fixes"
run gh api -X PUT "repos/${REPO}/private-vulnerability-reporting"
run gh api -X PATCH "repos/${REPO}" --input scripts/repo-settings/security-and-analysis.json

if gh api "repos/${REPO}/pages" >/dev/null 2>&1; then
  run gh api -X PUT "repos/${REPO}/pages" -f build_type=workflow
else
  run gh api -X POST "repos/${REPO}/pages" -f build_type=workflow
fi

while IFS='|' read -r name color description; do
  [ -z "$name" ] && continue
  run gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force
done < scripts/repo-settings/labels.txt

run gh api -X POST "repos/${REPO}/rulesets" --input scripts/repo-settings/ruleset-main.json
run gh api -X POST "repos/${REPO}/rulesets" --input scripts/repo-settings/ruleset-tags.json

echo "Done. Remaining UI-only steps are listed in docs/decisions/0001-record-architecture-decisions.md (appendix)."
