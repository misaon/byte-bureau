interface Closable {
  readonly close: () => Promise<void>
}

// The failure of the work is the one to report, so a close that fails after it says nothing
async function closeAfterFailure(resource: Closable): Promise<void> {
  try {
    await resource.close()
  } catch {
    // The work has failed already
  }
}

async function workOrClose<Resource extends Closable, Result>(
  resource: Resource,
  work: (resource: Resource) => Promise<Result>,
): Promise<Result> {
  try {
    return await work(resource)
  } catch (error) {
    await closeAfterFailure(resource)
    throw error
  }
}

// A resource for the length of the work, closed after it; a close that fails when the work went well is reported
export async function withResource<Resource extends Closable, Result>(
  open: () => Promise<Resource>,
  work: (resource: Resource) => Promise<Result>,
): Promise<Result> {
  const resource = await open()
  const result = await workOrClose(resource, work)
  await resource.close()
  return result
}
