import { pickFiles, uploadDocument } from "../api";
export function installDropOpenBridge() {
  window.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    if ((event.target as Element)?.closest(".ai-composer")) return;
    event.preventDefault();
    void uploadDocument(files[0]!)
      .then((document) =>
        window.dispatchEvent(
          new CustomEvent("sw-office-open", { detail: { docId: document.draftId } }),
        ),
      )
      .catch((error) => alert(error.message));
  });
}
