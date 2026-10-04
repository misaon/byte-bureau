import { describe, expect, it } from 'vitest'
import { BureauRpcs, RPC_TAGS } from './rpc.js'

describe('the RPC group', () => {
  it('declares one streaming subscription and one procedure per mutation of the API', () => {
    expect(RPC_TAGS).toStrictEqual([
      'events.subscribe',
      'projects.register',
      'projects.remove',
      'sessions.create',
      'sessions.prompt',
      'sessions.interrupt',
      'sessions.stop',
      'sessions.resume',
      'sessions.complete',
      'asks.answer',
      'workspaces.prune',
    ])
    expect([...BureauRpcs.requests.keys()]).toStrictEqual(RPC_TAGS)
  })
})
