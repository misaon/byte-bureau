import { stripVTControlCharacters } from 'node:util'
import { S_BAR_END, S_BAR_START } from '@clack/prompts'

// The lines that begin with the glyph and the two spaces clack puts after it; the ASCII glyphs of TERM=linux turn up inside the words as well (the end of the frame is an em dash)
function linesStartingWith(text: string, glyph: string): number {
  const lines = stripVTControlCharacters(text).split('\n')
  return lines.filter((line) => line.startsWith(`${glyph}  `)).length
}

// How often the frame of a run was opened and closed on the terminal
export function frames(text: string): { readonly starts: number; readonly ends: number } {
  return {
    starts: linesStartingWith(text, S_BAR_START),
    ends: linesStartingWith(text, S_BAR_END),
  }
}
