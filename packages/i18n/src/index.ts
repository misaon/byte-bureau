import { baseLocale, locales, overwriteGetLocale, type Locale } from './paraglide/runtime.js'

let activeLocale: Locale = baseLocale

overwriteGetLocale(() => activeLocale)

export function setLocale(locale: Locale): void {
  activeLocale = locale
}

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value)
}

export * as m from './paraglide/messages.js'
export { baseLocale, locales, type Locale } from './paraglide/runtime.js'
