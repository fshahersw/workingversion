# Why the Paraquat batch failed, and how to fix it

## What happened

Batch `041dfb92…` (`paraquat-products-liability-mdl-3004`) ran for ~32 minutes and got all the way through store, write, parties and extract cleanly:

- 7,027 docket rows, 5,876 entries, 205 PDFs stored, 150 parties/counsel, 0 rejects, 0 warnings
- 355 documents extracted, 1,912 chunks created

It then failed in the **embed** stage with `HTTP Error 400: Bad Request` from Voyage. Only 192 of the 1,912 chunks got embeddings; 1,720 are still `embedding IS NULL`. Nothing is corrupt — the batch stopped, it did not half-write bad data.

## Root cause

The embed stage sends chunks in fixed batches of 96, truncating each to 8,000 characters. Paraquat's chunks are unusually large — average 3,019 characters, **maximum 76,480**. A 96-chunk request of near-8,000-character chunks is roughly 200K+ tokens, well over Voyage's per-request token limit, so the API rejects the whole request with 400.

Earlier matters succeeded because their chunks were small enough that 96 × chunk stayed under the cap. This is a size-dependent bug, not a Paraquat-specific one — any matter with long chunks will hit it.

Two aggravating factors found in the same inspection:

1. **The retry wrapper retries 400s.** `embed_with_backoff` catches every exception and retries 6 times with backoff. A 400 is deterministic, so this just wastes ~4 minutes before failing, and the underlying Voyage error body is never logged — the operator only sees "Bad Request".
2. **Some chunks are extraction garbage.** One unembedded chunk is 12,003 characters of `/0/1/2/3/4/5/i255/…` — a PDF with no proper text layer producing CID-token noise. It inflates request size and pollutes the search index.

## The fix

1. **Token-aware batching in `stage_embed`** (`scripts/pipeline/run_batch.py`): replace the fixed 96-row batch with a budget-based batcher that accumulates chunks until either 96 rows or a conservative character budget (~90K characters per request, well under the token cap) is reached, whichever comes first. Any single chunk longer than the per-chunk truncation limit is sent alone.
2. **Lower per-chunk truncation** from 8,000 to a safer limit, so one pathological chunk can never blow the request by itself.
3. **Don't retry client errors.** In `embed_with_backoff`, re-raise immediately on HTTP 4xx other than 429, and include the Voyage response body in the error message so the next failure names itself.
4. **Skip junk chunks.** Before embedding, skip chunks whose content is dominated by CID/glyph-token noise (a simple ratio check on `/nnn` tokens and non-alphabetic characters), marking them so they are not retried forever. These come from image-only PDFs with no text layer; they should not be in the vector index.
5. **Investigate the 76K-character chunk separately.** The chunker is supposed to bound chunk size; a 76,480-character chunk means one document bypassed splitting. Worth a follow-up read of the chunk function, but it is not blocking the fix above.

## Recovery for Paraquat

No re-upload and no new batch needed. After the fix:

- Reset batch `041dfb92…` to `queued` with stage cleared, and let a worker pick it up (or run `run_batch.py --batch 041dfb92-4541-4195-97a4-23c696f3ac5e --once`).
- Every stage is idempotent and the embed stage only selects `embedding IS NULL`, so it resumes at the remaining 1,720 chunks rather than redoing the 32 minutes of store/extract work.
- Verify afterwards: unembedded chunk count is 0 and the batch is `completed`.

## Technical notes

- Failure point is `stage_embed` → `embed_with_backoff` → `voyage_embed` (`scripts/pipeline/ingest_matter.py`), which raises `urllib.error.HTTPError` without reading `e.read()`, which is why the body was lost.
- `ingest_matter.py` has its own copy of `voyage_embed` with the same 429-only retry; the batching fix belongs in the shared helper so both callers get it.
- No schema change, no ingest-contract change, no endpoint change.
