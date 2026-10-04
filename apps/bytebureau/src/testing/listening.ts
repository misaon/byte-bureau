import { once } from 'node:events'
import type { Server } from 'node:net'

export interface Listening {
  readonly port: number
  // Stops listening, and settles once the server has closed
  readonly close: () => Promise<void>
}

// The server listening on a free loopback port
export async function listening(server: Server): Promise<Listening> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const close = async (): Promise<void> => {
    const closed = once(server, 'close')
    server.close()
    await closed
  }
  return { port, close }
}
