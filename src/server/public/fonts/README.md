Self-hosted web fonts, served from here so the page never calls a font CDN
(the CSP allows `font-src 'self'` only).

- `*-regular.woff2`: weight 400, one file per family covering Latin and Cyrillic.
- `*-600-latin.woff2`, `*-600-cyrillic.woff2`: weight 600 from
  [Fontsource](https://fontsource.org) 5.3.0, fetched as-is from
  `https://cdn.jsdelivr.net/npm/@fontsource/<family>@5.3.0/files/<family>-<subset>-600-normal.woff2`.
  Work Sans has no Cyrillic, so it ships Latin only. The `unicode-range` on
  each `@font-face` in `style.css` is Fontsource's range for that subset.

All six families (JetBrains Mono, Fira Code, IBM Plex Mono, IBM Plex Sans,
Inter, Work Sans) are licensed under the SIL Open Font License 1.1. To update:
re-fetch the same URLs with a newer version pin and replace the files.
