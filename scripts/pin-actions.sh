#!/usr/bin/env bash
# Rewrites `uses: owner/repo@tag` into `uses: owner/repo@<sha> # tag` across workflows and composite actions.
set -euo pipefail

files=$(git ls-files '.github/workflows/*.yml' '.github/actions/*/action.yml')
refs=$(grep -hoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@v?[0-9][A-Za-z0-9_.-]*' $files | sed 's/^uses: //' | grep -vE '@[0-9a-f]{40}$' | sort -u || true)

for ref in $refs; do
  repo_path="${ref%@*}"
  tag="${ref##*@}"
  owner_repo="$(printf '%s' "$repo_path" | cut -d/ -f1,2)"
  if ! gh api "repos/${owner_repo}/git/ref/tags/${tag}" >/dev/null 2>&1; then
    echo "tag ${tag} not found for ${owner_repo}; pick the newest from: gh api repos/${owner_repo}/tags --jq '.[].name' and update the workflow" >&2
    exit 1
  fi
  object_type="$(gh api "repos/${owner_repo}/git/ref/tags/${tag}" --jq '.object.type')"
  sha="$(gh api "repos/${owner_repo}/git/ref/tags/${tag}" --jq '.object.sha')"
  if [ "$object_type" = "tag" ]; then
    sha="$(gh api "repos/${owner_repo}/git/tags/${sha}" --jq '.object.sha')"
  fi
  for file in $files; do
    sed -i.bak "s#uses: ${ref}\$#uses: ${repo_path}@${sha} \# ${tag}#" "$file" && rm -f "${file}.bak"
  done
  echo "${ref} -> ${sha}"
done
