// Whether a process of that id exists: signal 0 only asks, and a process this one may not signal (EPERM) exists all the same
// Zero and the negative numbers name process groups to kill, not a process, so they name none here
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    return process.kill(pid, 0)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
