# Oracle provider fallback artwork

These WebP files are copies of the provider artwork served by
`https://v3.euler.finance/v3/images/oracle-providers/{key}`, retrieved on 2026-10-13.
The filenames match the keys in `entities/oracle-providers.ts`.

Lite bundles these files for the Explore and vault oracle rows. The remote image
is preferred when it loads; the bundled copy covers loading, missing image URLs,
and image-request failures. Update a file from the same managed endpoint when
its provider artwork changes. Keep unknown providers unmapped rather than
substituting another provider's brand.
