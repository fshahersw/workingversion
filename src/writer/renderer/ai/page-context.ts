export interface WriterPageBlock { blockIndex: number; firstPage: number; lastPage: number }
export interface WriterPageContext { pages: number; page: number; blocks: WriterPageBlock[]; truncated: boolean }

/** Only send the requested visible page; a full large document map wastes the
 * model budget and can conceal that a paragraph crosses page boundaries. */
export function writerPageContext(pages: number, current: number, blocks: WriterPageBlock[], requested?: number): WriterPageContext | null {
  const page = requested ?? current
  if (!Number.isInteger(page) || page < 1 || page > pages) return null
  const matches = blocks.filter(block => block.firstPage <= page && block.lastPage >= page)
  return { pages, page, blocks: matches.slice(0, 200), truncated: matches.length > 200 }
}
