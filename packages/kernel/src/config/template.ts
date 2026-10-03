import { defaultProjectConfig } from '@bytebureau/protocol'

// Commented JSONC for `bytebureau config init`; comments are the documentation
export function defaultProjectConfigText(): string {
  const employee = JSON.stringify(
    defaultProjectConfig.employees['developer'],
    undefined,
    2,
  ).replaceAll('\n', '\n    ')
  return `{
  "$schema": "https://bytebureau.dev/schema/v1/config.json",
  "version": 1,
  // Project identity; defaultBranch (optional) overrides the detected default branch: origin/HEAD, else main
  "project": { "name": ${JSON.stringify(defaultProjectConfig.project.name)} },
  // Worktrees live under .bytebureau/worktrees; copyIgnored files are copied from the main checkout
  "workspace": { "runtime": "local", "copyIgnored": [".env", ".env.local"], "retainDays": 7 },
  "providers": { "claude": { "executable": "claude", "settingSources": ["user", "project", "local"] } },
  // Employees: one entry per role; prompt points at a Markdown file with the system prompt
  "employees": {
    "developer": ${employee}
  },
  // branch (optional) is the base of session worktrees; it defaults to the project's default branch
  "defaults": { "employee": "developer" },
  "plugins": [],
  "logging": { "level": "info" }
}
`
}
