// A successful native save replaces its source session. No renderer mutation
// may enter between the submitted journal and the corresponding reopen.
const committing = new WeakSet<object>()

export function isWorkbookSaveCommitting(state: object | null | undefined): boolean {
  return !!state && committing.has(state)
}

export function beginWorkbookSaveCommit(state: object): () => void {
  if (committing.has(state)) throw new Error('A workbook save is already in progress.')
  committing.add(state)
  const target = typeof document === 'undefined' ? null : document
  const events = ['pointerdown', 'click', 'keydown', 'beforeinput', 'paste', 'drop', 'submit']
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  // Includes editor portals and keyboard shortcuts while the native request
  // is pending. Programmatic workbook mutations use the command gate as well.
  for (const name of events) target?.addEventListener(name, block, true)
  return () => {
    committing.delete(state)
    for (const name of events) target?.removeEventListener(name, block, true)
  }
}
