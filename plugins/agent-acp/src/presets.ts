export type PresetId = 'codex' | 'gemini' | 'opencode' | 'pi' | 'custom'

export interface Preset {
  readonly id: PresetId
  readonly displayName: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  // The variable a login profile's directory travels in, where the agent has one
  readonly configDirEnv?: string | undefined
  // The variable an API-key profile's key travels in, where the agent takes one
  readonly apiKeyEnv?: string | undefined
  readonly installHint: string
  // A bare command: the CLI prints it after "Log in with: "; pi asks for its provider login on first run
  readonly loginHint: string
}

export const PRESETS: Readonly<Record<Exclude<PresetId, 'custom'>, Preset>> = {
  codex: {
    id: 'codex',
    displayName: 'Codex (ACP)',
    command: 'codex-acp',
    args: [],
    env: {},
    configDirEnv: 'CODEX_HOME',
    apiKeyEnv: 'OPENAI_API_KEY',
    installHint: 'install it with: npm install -g @agentclientprotocol/codex-acp',
    loginHint: 'codex login',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI (ACP)',
    command: 'gemini',
    args: ['--acp'],
    env: {},
    apiKeyEnv: 'GEMINI_API_KEY',
    installHint: 'install it with: npm install -g @google/gemini-cli',
    loginHint: 'gemini',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode (ACP)',
    command: 'opencode',
    args: ['acp'],
    env: {},
    installHint: 'install it with: npm install -g opencode-ai',
    loginHint: 'opencode auth login',
  },
  pi: {
    id: 'pi',
    displayName: 'pi (ACP)',
    command: 'pi-acp',
    args: [],
    env: {},
    installHint: 'install it with: npm install -g pi-acp @earendil-works/pi-coding-agent',
    loginHint: 'pi',
  },
}

export const providerIdOf = (preset: PresetId): string => `acp:${preset}`
