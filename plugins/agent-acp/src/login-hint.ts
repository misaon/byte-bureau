import type { ProfileRef } from '@bytebureau/plugin-api'
import type { Preset } from './presets.js'

// A word a shell would split or expand is quoted, so the command can be pasted as it is (a copy of the Claude adapter's)
const shellWord = (value: string): string =>
  /^[\w./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`

// A login profile logs in where its agent looks: in the directory the preset's variable hands the agent; the bare command otherwise
export const loginHintOf = (
  preset: Pick<Preset, 'configDirEnv' | 'loginHint'>,
  profile: ProfileRef,
): string => {
  const { configDirEnv, loginHint } = preset
  const { kind, configDir } = profile
  return kind === 'login' && configDir !== undefined && configDirEnv !== undefined
    ? `${configDirEnv}=${shellWord(configDir)} ${loginHint}`
    : loginHint
}
