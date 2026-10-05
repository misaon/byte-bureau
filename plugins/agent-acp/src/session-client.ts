import type { SessionNotification } from '@agentclientprotocol/sdk'
import { readTextFile, writeTextFile } from './client-fs.js'
import type { Terminals } from './client-terminal.js'
import type { ClientHandlers } from './connection.js'
import type { PermissionBroker } from './permissions.js'

// What a session serves its agent with
interface Serving {
  readonly workspace: string
  readonly asks: PermissionBroker
  readonly terminals: Terminals
  readonly updated: (notification: SessionNotification) => void
}

// The client side of a session: the updates it tells, the permissions it brokers, the files of the workspace and its terminals
export const clientOf = ({ workspace, asks, terminals, updated }: Serving): ClientHandlers => ({
  sessionUpdate: updated,
  requestPermission: async (params, signal) => {
    const response = await asks.request(params, signal)
    return response
  },
  readTextFile: async (params) => {
    const response = await readTextFile(workspace, params)
    return response
  },
  writeTextFile: async (params) => {
    const response = await writeTextFile(workspace, params)
    return response
  },
  createTerminal: async (params) => {
    const response = await terminals.create(params)
    return response
  },
  terminalOutput: (params) => terminals.output(params),
  waitForTerminalExit: async (params) => {
    const response = await terminals.waitForExit(params)
    return response
  },
  killTerminal: (params) => terminals.kill(params),
  releaseTerminal: (params) => terminals.release(params),
})
