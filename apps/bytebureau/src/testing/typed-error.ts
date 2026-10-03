// An Error with an empty message, such as an error of a library, whose name and fields tell what went wrong
export function typedError(name: string, fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error('placeholder'), { name, message: '' }, fields)
}
