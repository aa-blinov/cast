Vendored third-party browser bundles — served locally so file preview's
markdown/syntax highlighting works fully offline, no CDN at request time.

- `marked.min.mjs` — marked 13.0.3 (MIT), bundled ESM build from
  `https://cdn.jsdelivr.net/npm/marked@13/+esm`.
- `highlight.min.mjs` — highlight.js 11.11.1 (BSD-3-Clause), bundled ESM
  build (all languages) from `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/+esm`.
- `dompurify.min.mjs` — DOMPurify 3.4.14 (Apache-2.0 OR MPL-2.0), bundled ESM
  build from `https://cdn.jsdelivr.net/npm/dompurify@3/+esm`. Sanitizes
  `marked`'s HTML output before it's used with `dangerouslySetInnerHTML` —
  file preview renders arbitrary user/repo files, so the markdown source is
  untrusted input (e.g. a `<script>` or `<img onerror>` in a `.md` file).

All three are jsDelivr's Rollup/esbuild-bundled `+esm` output, saved as-is
(only the trailing `sourceMappingURL` comment stripped, since the matching
`.map` file isn't vendored). To update: re-fetch the same URL with a newer
version pin and replace the file — no build step, no npm dependency.
