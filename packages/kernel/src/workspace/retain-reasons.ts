// Why a worktree is kept: a user reads these in workspace.retained and in the report of `workspaces prune`
export const RETAINED = {
  uncommitted: 'uncommitted changes',
  notOnRemote: 'commits not on origin',
  statusUnavailable: 'status unavailable',
} as const
