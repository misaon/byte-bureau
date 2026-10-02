import { baseLocale, isLocale, type Locale } from '@bytebureau/i18n'

export interface LocaleSources {
  readonly flag?: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface LocaleResolution {
  readonly locale: Locale
  readonly unsupported?: string
}

interface Candidate {
  readonly value: string | undefined
  readonly explicit: boolean
}

function languageTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_.@-].*$/u, '')
}

export function resolveLocale({ flag, env }: LocaleSources): LocaleResolution {
  const candidates: readonly Candidate[] = [
    { value: flag, explicit: true },
    { value: env['BYTEBUREAU_LANG'], explicit: true },
    { value: env['LC_ALL'], explicit: false },
    { value: env['LANG'], explicit: false },
  ]
  for (const { value, explicit } of candidates) {
    if (value !== undefined && value.trim() !== '') {
      const tag = languageTag(value)
      if (isLocale(tag)) {
        return { locale: tag }
      }
      if (explicit) {
        return { locale: baseLocale, unsupported: value }
      }
    }
  }
  return { locale: baseLocale }
}
