Update the site's social preview image to the existing Seeger Weiss logo asset.

1. Import `src/assets/sw-logo.asset.json` (the full Seeger Weiss logo) into `src/routes/__root.tsx`.
2. Replace the current absolute `og:image` and `twitter:image` URLs with the imported asset's `url`.
3. Keep all other meta tags (title, description, og:type, twitter:card) unchanged.
4. Run the TypeScript check to confirm the JSON import resolves cleanly.
5. Verify in the preview that the `<meta property="og:image">` tag now points to the Seeger Weiss logo asset path.
