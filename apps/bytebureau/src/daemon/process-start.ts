import { spawn } from 'node:child_process'

// What ps prints for lstart in the C locale and UTC, the same on macOS and Linux: "Sun Oct  4 17:30:45 2026"
const LSTART =
  /^[A-Za-z]{3} (?<month>[A-Za-z]{3}) +(?<day>\d{1,2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4})$/u

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The moment an lstart of UTC names, to the second, as ps gives it; nothing for any other text
export const lstartTime = (text: string): number | undefined => {
  const found = LSTART.exec(text.trim())
  if (found === null || found.groups === undefined) {
    return undefined
  }
  const { month = '', day, hour, minute, second, year } = found.groups
  const index = MONTHS.indexOf(month)
  return index === -1
    ? undefined
    : Date.UTC(Number(year), index, Number(day), Number(hour), Number(minute), Number(second))
}

// What a command printed; no text when it cannot run, fails or takes too long
const outputOf = async (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  const { promise, resolve } = Promise.withResolvers<string>()
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    windowsHide: true,
  })
  const chunks: string[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    chunks.push(chunk)
  })
  child.once('error', () => {
    resolve('')
  })
  child.once('close', (code) => {
    resolve(code === 0 ? chunks.join('') : '')
  })
  const output = await promise
  return output
}

// The locale and the zone of the user would change the words and the hour ps prints
const posixStart = async (pid: number): Promise<number | undefined> => {
  const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  const text = await outputOf('ps', ['-o', 'lstart=', '-p', String(pid)], env)
  return lstartTime(text)
}

// At best: PowerShell tells the start of a process it can see, to the millisecond
const windowsStart = async (pid: number): Promise<number | undefined> => {
  const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`
  const text = await outputOf('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const time = Date.parse(text.trim())
  return Number.isNaN(time) ? undefined : time
}

/**
 * When a process started, as the platform tells it, to the second at worst and never later than it did; nothing when
 * the platform cannot tell. A file a process wrote is never older than the process: one older than its pid's process
 * was written by another that had the pid before.
 */
export const processStartedAt = async (pid: number): Promise<number | undefined> => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined
  }
  const started = await (process.platform === 'win32' ? windowsStart(pid) : posixStart(pid))
  return started
}
