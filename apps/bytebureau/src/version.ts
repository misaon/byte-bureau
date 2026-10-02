declare const BYTEBUREAU_VERSION: string | undefined

export const version: string =
  typeof BYTEBUREAU_VERSION === 'string' ? BYTEBUREAU_VERSION : '0.0.0-dev'
