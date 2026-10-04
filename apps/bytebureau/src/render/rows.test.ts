import type { SessionDto } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { askOf, option, question } from '../testing/events.js'
import { ASK, SESSION } from '../testing/records.js'
import { askRows, pluginRows, sessionFields, sessionRows } from './rows.js'

// A session whose worktree is not made yet: the wire tells it as null, which JSON text keeps out of the CLI sources
function withoutWorktree(session: SessionDto): SessionDto {
  const bare = { ...session }
  Reflect.set(bare, 'workspace', JSON.parse('null'))
  return bare
}

describe(sessionRows, () => {
  it('has the id, the status, the title and the project of every session', () => {
    expect(sessionRows([SESSION])).toStrictEqual([['s1', 'ready', 'Fix the build', 'p1']])
    expect(sessionRows([])).toStrictEqual([])
  })
})

describe(sessionFields, () => {
  it('labels the fields of a session, down to the path of its worktree', () => {
    expect(sessionFields(SESSION)).toStrictEqual([
      ['id', 's1'],
      ['status', 'ready'],
      ['title', 'Fix the build'],
      ['project', 'p1'],
      ['employee', 'developer'],
      ['provider', 'fake'],
      ['worktree', '/repo/.bytebureau/worktrees/s1'],
      ['created', '2026-10-02T12:00:00.000Z'],
    ])
  })

  it('has a dash for the worktree of a session that has none yet', () => {
    const fields = sessionFields(withoutWorktree({ ...SESSION, status: 'created' }))
    expect(fields).toContainEqual(['worktree', '-'])
  })
})

// An ask of the fixtures, with the questions it asks
function asking(...questions: ReturnType<typeof question>[]): typeof ASK {
  return { ...ASK, ...askOf(questions) }
}

describe(askRows, () => {
  it('has the id, the session, the title and the recommended option of every ask', () => {
    const options = [option('a', false), option('b', true)]
    const rows = askRows([asking(question(options))])
    expect(rows).toStrictEqual([['a1', 's1', 'Export style', 'Option b']])
  })

  it('lists the recommended options of every question, and none for an ask that recommends nothing', () => {
    const several = asking(question([option('a', true)]), question([option('b', true)]))
    const none = asking(question([option('a', false)]))
    expect(askRows([several, none])).toStrictEqual([
      ['a1', 's1', 'Export style', 'Option a, Option b'],
      ['a1', 's1', 'Export style', ''],
    ])
  })
})

describe(pluginRows, () => {
  it('has the name, the version, the state and the ports of a plugin, which are joined', () => {
    const loaded = {
      name: 'agent-fake',
      version: '0.1.0',
      state: 'loaded',
      ports: ['a', 'b'],
    } as const
    expect(pluginRows([loaded])).toStrictEqual([['agent-fake', '0.1.0', 'loaded', 'a,b']])
  })

  it('has the reason of a plugin that failed in place of its ports', () => {
    const failed = {
      name: 'broken',
      version: '1.0.0',
      state: 'failed',
      ports: [],
      reason: 'no hostApi',
    } as const
    const nothing = { name: 'odd', version: '1.0.0', state: 'failed', ports: [] } as const
    expect(pluginRows([failed, nothing])).toStrictEqual([
      ['broken', '1.0.0', 'failed', 'no hostApi'],
      ['odd', '1.0.0', 'failed', ''],
    ])
  })
})
