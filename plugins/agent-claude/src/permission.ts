import type { EmployeeSpec } from '@bytebureau/protocol'

// Supervised employees are asked through canUseTool; autonomous ones run on the SDK's classifier, which asks when unsure
// The kernel refuses yolo before the adapter sees it; should one get through, it is refused here too
export const permissionModeOf = (mode: EmployeeSpec['permissionMode']): 'default' | 'auto' => {
  if (mode === 'yolo') {
    throw new Error('yolo is refused: the workspace runtime has no isolation')
  }
  return mode === 'supervised' ? 'default' : 'auto'
}
