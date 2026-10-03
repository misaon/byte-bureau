import { describe, expect, it } from 'vitest'
import { shellWords } from './shell-words.js'

const texts = (command: string): readonly string[] => shellWords(command).map((word) => word.text)
const expansions = (command: string): readonly boolean[] =>
  shellWords(command).map((word) => word.expanded)

describe(shellWords, () => {
  it('splits at blanks outside quotes and keeps a quoted blank in its word', () => {
    expect(texts(`cat "a b"  'c d'\te"f g"h`)).toStrictEqual(['cat', 'a b', 'c d', 'ef gh'])
  })

  it('keeps an empty pair of quotes as an empty word and drops blank space', () => {
    expect([texts('cat ""'), texts('  \t ')]).toStrictEqual([['cat', ''], []])
  })

  it('drops the escapes the shell drops: any outside quotes, and before $ ` " \\ inside double quotes', () => {
    expect(texts(String.raw`cat my\ file \.env "a\"b" "c\d" 'e\f'`)).toStrictEqual([
      'cat',
      'my file',
      '.env',
      'a"b',
      String.raw`c\d`,
      String.raw`e\f`,
    ])
  })
})

describe('shellWords expansions', () => {
  it('marks globs, braces, variables and escapes outside quotes', () => {
    expect(expansions(String.raw`a* b? [c] {d,e} $f \g h`)).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ])
  })

  it('marks variables, substitutions and escapes inside double quotes, and nothing inside single quotes', () => {
    expect(expansions(String.raw`"a*" "$b" "\c" '$d' '\e'`)).toStrictEqual([
      false,
      true,
      true,
      false,
      false,
    ])
  })

  it('marks a tilde that starts a word only', () => {
    expect(expansions('~ ~/a a~b ""~')).toStrictEqual([true, true, false, false])
  })

  it('marks a word that an unterminated quote or a trailing escape leaves open', () => {
    expect([expansions('cat "open'), expansions('cat end\\')]).toStrictEqual([
      [false, true],
      [false, true],
    ])
  })
})
