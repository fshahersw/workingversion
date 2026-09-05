# Fix Summarize uploads on iPhone Safari

## Outcome
PDF uploads will get past **Reading files** on mobile Safari and continue into the temporary Docling conversion workflow instead of failing with `undefined is not a function`.

## Implementation
1. **Use a Safari-compatible PDF.js pair**
   - Switch browser PDF parsing from the modern PDF.js entry to its legacy-compatible entry.
   - Serve the matching legacy worker from the same installed PDF.js version so the main bundle and worker cannot drift.
   - Keep the current page-level extraction, progress reporting, file limits, and Docling fallback behavior unchanged.

2. **Make compatibility failure explicit**
   - Guard the PDF initialization boundary and translate low-level browser/library errors into a clear file-specific message.
   - Ensure one failed file cleanly marks the reading step as failed and can be reset without leaving stale work behind.

3. **Add regression coverage**
   - Test PDF initialization with `Promise.withResolvers` unavailable, matching the affected Safari environment.
   - Verify a representative PDF reaches extracted pages and that cancellation/error state still behaves correctly.

4. **Validate the real workflow**
   - Run the focused pile tests.
   - Exercise the Summarize upload flow in a browser configured to emulate the missing Safari API, checking that it reaches indexing rather than the error card.
   - Check the responsive mobile layout after the successful transition.

## Technical note
The project currently imports `pdfjs-dist`’s modern browser build and serves its modern worker. Both contain direct `Promise.withResolvers` calls. The legacy PDF.js distribution includes the compatibility layer needed by Safari versions that do not provide this API natively; both sides must be changed together.
