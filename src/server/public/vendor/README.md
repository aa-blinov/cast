Vendored third-party browser bundles — served locally so file preview's
markdown/syntax highlighting works fully offline, no CDN at request time.

- `marked.min.mjs` — marked 13.0.3 (MIT), bundled ESM build from
  `https://cdn.jsdelivr.net/npm/marked@13/+esm`.
- `highlight.min.mjs` — highlight.js 11.11.1 (BSD-3-Clause), bundled ESM
  build (all languages) from `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/+esm`.

Both are jsDelivr's Rollup/esbuild-bundled `+esm` output, saved as-is
(only the trailing `sourceMappingURL` comment stripped, since the matching
`.map` file isn't vendored). To update: re-fetch the same URL with a newer
version pin and replace the file — no build step, no npm dependency.
