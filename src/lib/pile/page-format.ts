/** Make retrieved page text readable in the citation pane without flattening it. */
export function formatRetrievedPage(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
