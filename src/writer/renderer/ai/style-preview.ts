import JSZip from 'jszip'
import { mergeStylesXml, type ParsedDocFull, type StyleUpsert } from '@genoffice/docx-engine'
import { parseStyles } from '../../packages/docx-engine/src/parse-styles'

const sourceStyles = new WeakMap<ParsedDocFull, Promise<string>>()
const EMPTY_STYLES = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>'

/** Parse precisely the same style patches that native save writes, without
 * changing the source package or reparsing the document body. */
export async function previewStyleDefinitions(parsed: ParsedDocFull, pending: Record<string, StyleUpsert>) {
  let source = sourceStyles.get(parsed)
  if (!source) {
    source = JSZip.loadAsync(parsed.internal.originalBytes)
      .then(zip => zip.file('word/styles.xml')?.async('string') ?? EMPTY_STYLES)
    sourceStyles.set(parsed, source)
  }
  const zip = new JSZip()
  zip.file('word/styles.xml', mergeStylesXml(await source, Object.values(pending)))
  return parseStyles(zip, parsed.themeColors, parsed.themeFonts)
}
