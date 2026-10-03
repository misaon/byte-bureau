// The tagged errors of the kernel are Errors with an empty message; their name and fields tell what went wrong
export function typedError(name: string, fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error('placeholder'), { name, message: '' }, fields)
}
