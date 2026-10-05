import { RpcSchema } from 'effect/rpc'
import { describe, expect, it } from 'vitest'
import { Problem } from './problem.js'
import { BureauRpcs, RPC_TAGS } from './rpc.js'

// Every procedure but the subscription: one per mutation of the API, and the reads of a profile
const PROCEDURES = [
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
  'profiles.list',
  'profiles.add',
  'profiles.remove',
  'profiles.setDefault',
  'profiles.status',
  'usage.profile',
]

// Each procedure of the group, by its tag
const procedures = [...BureauRpcs.requests.entries()]

describe('the RPC group', () => {
  it('declares one streaming subscription, a procedure per mutation of the API and the reads of a profile', () => {
    expect(RPC_TAGS).toStrictEqual(['events.subscribe', ...PROCEDURES])
  })

  it('streams the events of the subscription alone, and answers every other procedure once', () => {
    const streaming = procedures.filter(([, rpc]) => RpcSchema.isStreamSchema(rpc.successSchema))
    expect(streaming.map(([tag]) => tag)).toStrictEqual(['events.subscribe'])
  })

  it('fails every procedure but the subscription with a problem', () => {
    const answered = procedures.filter(([tag]) => tag !== 'events.subscribe')
    expect(answered.map(([tag]) => tag)).toStrictEqual(PROCEDURES)
    expect(answered.filter(([, rpc]) => rpc.errorSchema !== Problem)).toStrictEqual([])
  })
})
