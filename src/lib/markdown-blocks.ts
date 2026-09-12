/**
 * Split a markdown document into independently renderable top-level blocks.
 *
 * During a long stream the answer is re-parsed from scratch on every frame; by
 * rendering each block through a memoized component, only the block the
 * stream is currently appending to is re-parsed. Splits happen at blank lines
 * only, and never:
 *   - inside a fenced code block (``` or ~~~), where blank lines are content;
 *   - before an indented line, which is a continuation of the previous list
 *     item or paragraph and would otherwise render as a stray code block.
 * CommonMark keeps an ordered list's `start` number from its first item, so a
 * loose list split across blocks keeps its numbering.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    // Trim only trailing blank lines so intra-block spacing is preserved.
    while (current.length && current[current.length - 1]!.trim() === "") current.pop();
    if (current.length) blocks.push(current.join("\n"));
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      current.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      if (!current.length) continue; // collapse leading / repeated blank lines
      // Look ahead: an indented next non-blank line continues this block.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      const next = lines[j];
      if (next !== undefined && /^\s+\S/.test(next)) {
        current.push(line);
        continue;
      }
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
