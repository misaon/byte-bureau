import { ApiError, createBureauClient, type RpcConnection } from '@bytebureau/client'
import { describe, expect, it, onTestFinished } from 'vitest'
import { startDaemonProcess } from '../testing/daemon.js'
import { createTempRepo, testHome } from '../testing/temp-repo.js'

// The socket of a client of the daemon, closed when the test ends if the test has not closed it
async function socketOf(url: string, token: string): Promise<RpcConnection> {
  const connection = await createBureauClient({ baseUrl: url, token }).rpc.connect()
  onTestFinished(() => {
    connection.close()
  })
  return connection
}

// The first value the stream gives; leaving the loop interrupts the request on the daemon
async function firstOf(values: AsyncIterable<unknown>): Promise<unknown> {
  for await (const value of values) {
    return value
  }
  return undefined
}

const idOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : undefined

// The first event of a project since the start of the log, over the socket
async function firstEventOf(socket: RpcConnection, projectId: unknown): Promise<unknown> {
  const event = await firstOf(socket.stream('events.subscribe', { projectId, since: 0 }))
  return event
}

// The upgrade to the socket runs on the Bun server of the daemon only: the API tests run it on Node
describe('the RPC socket of a daemon on Bun', () => {
  it('runs a procedure, refuses with its problem and streams the events chunk by chunk', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(testHome())
    const socket = await socketOf(daemon.url, daemon.info.token)
    const repo = createTempRepo()
    const id = idOf(await socket.call('projects.register', { path: repo }))
    await expect(socket.call('projects.remove', { id: 'nobody' })).rejects.toMatchObject({
      status: 404,
      problem: { code: 'not_found' },
    })
    await expect(firstEventOf(socket, id)).resolves.toMatchObject({
      type: 'project.registered',
      projectId: id,
    })
    // The socket still serves a procedure after a stream it left early
    await expect(socket.call('projects.remove', { id })).resolves.toBeNull()
    socket.close()
    await daemon.stop()
  })

  it('refuses a procedure whose token is not the one of the daemon', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(testHome())
    const socket = await socketOf(daemon.url, 'not-the-token')
    const refused = socket.call('projects.register', { path: createTempRepo() })
    await expect(refused).rejects.toBeInstanceOf(ApiError)
    await expect(refused).rejects.toMatchObject({ status: 401, problem: { code: 'unauthorized' } })
    socket.close()
    await daemon.stop()
  })
})
