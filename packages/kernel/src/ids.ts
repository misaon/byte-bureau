import { v7 } from 'uuid'

export const uuidv7 = (): string => v7()
export const nowIso = (): string => new Date().toISOString()
