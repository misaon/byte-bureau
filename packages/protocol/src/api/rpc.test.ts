import { RpcSchema } from 'effect/rpc'
import { describe, expect, it } from 'vitest'
import { Problem } from './problem.js'
import { BureauRpcs, RPC_TAGS } from './rpc.js'

const MUTATIONS = [
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
]

// Each procedure of the group, by its tag
const procedures = [...BureauRpcs.requests.entries()]

describe('the RPC group', () => {
  it('declares one streaming subscription and one procedure per mutation of the API', () => {
    expect(RPC_TAGS).toStrictEqual(['events.subscribe', ...MUTATIONS])
  })

  it('streams the events of the subscription alone, and answers every mutation once', () => {
    const streaming = procedures.filter(([, rpc]) => RpcSchema.isStreamSchema(rpc.successSchema))
    expect(streaming.map(([tag]) => tag)).toStrictEqual(['events.subscribe'])
  })

  it('fails every mutation with a problem', () => {
    const mutations = procedures.filter(([tag]) => tag !== 'events.subscribe')
    expect(mutations.map(([tag]) => tag)).toStrictEqual(MUTATIONS)
    expect(mutations.filter(([, rpc]) => rpc.errorSchema !== Problem)).toStrictEqual([])
  })
})
