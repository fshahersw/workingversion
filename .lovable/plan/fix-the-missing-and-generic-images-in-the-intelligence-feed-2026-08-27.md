# Fix the missing and generic images in the intelligence feed

Right now most rows have no picture at all, and the ones that do are mostly the Law360 logo repeated — the big feature block, the side features and the result thumbnails all show the same publisher mark. The uploaded reference pipeline solves exactly this, and our collector is missing three of its pieces.

## Why it looks like this today

- Our Tavily calls never ask for images. The reference pipeline sends `include_images`, `include_image_descriptions` and `include_favicon`, so every search result already carries real photo candidates. We throw that away.
- Only the top 40 stories get a Firecrawl scrape, so everything below that has no image source whatsoever.
- When Firecrawl does return `ogImage`, we accept it blindly and label it `editorial`. Publishers like Law360 put their logo in `og:image`, so a logo gets promoted into the hero slot.

## What to change in the collector

Port the reference pipeline's image selection into `src/lib/intel-collect.server.ts`:

1. **Ask Tavily for images.** Add `include_images`, `include_image_descriptions`, `include_favicon` to the search body and keep the returned image list plus favicon on each candidate.
2. **Collect all candidates per story**, in the reference's priority order: `ogImage` / `og:image` / `og:image:url` (100), `twitter:image` (94), Tavily images (70), then images pulled out of the Firecrawl markdown body (55).
3. **Score and filter them** with the reference's rules: bonus for a real photo extension and large declared width; heavy penalty for anything matching `logo|favicon|icon|avatar|pixel|sprite|banner|social-share-default`; hard reject for ad/tracking/1x1 URLs; drop everything below the cutoff.
4. **Label honestly.** The winner is stored as `kind: "editorial"` only when it does not look generic; logo-ish winners are stored as `kind: "generic"`. The UI already only uses `editorial` images, so a logo will simply not be shown as a hero.
5. **Better favicons** — prefer the Firecrawl/Tavily favicon, fall back to Google's favicon service instead of the current DuckDuckGo-only path.
6. **Widen enrichment** so more rows can get a picture: raise the Firecrawl scrape cap and prioritise scraping the stories that will land in the feature block and the top of the list.

## What to change in the UI

- Feature block and result rows get a proper no-image treatment instead of a stretched logo: a tinted panel with the source mark and category, sized identically to a real thumbnail so the dense grid stays aligned.
- The three feature slots prefer stories that actually have an editorial image, so the top of the page is always pictorial.

## After the change

Trigger one live collection run and report: how many stories were kept, how many now carry an editorial image, how many were rejected as generic, and any search/scrape errors.

## Technical notes

- All collector work is inside `src/lib/intel-collect.server.ts` (`tavilyPack`, `firecrawl`, the item mapping) plus a new `selectImage`/`imageQualityScore` pair ported from the reference file.
- No schema change: `image_url`, `image_kind` and `image_alt` already exist on the intel rows.
- UI edits are limited to `FeatureShowcase.tsx` and `ResultsPane.tsx` and use existing tokens.
