/**
 * Builds a UF2 file of `count` blocks.
 *
 * @param count - how many blocks
 * @param family - the family ID every block carries
 * @param flags - every block's flags
 * @returns the file
 */
export function uf2(count: number, family = 0xe48bff59, flags = 0x2000): Uint8Array {
  const bytes = new Uint8Array(512 * count)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < count; i++) {
    const at = i * 512
    view.setUint32(at, 0x0a324655, true)
    view.setUint32(at + 4, 0x9e5d5157, true)
    view.setUint32(at + 8, flags, true)
    view.setUint32(at + 28, family, true)
    view.setUint32(at + 508, 0x0ab16f30, true)
  }
  return bytes
}
