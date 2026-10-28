# Native allocator backport

`mimalloc-selective-purge.patch` backports only size-selective arena purging
from microsoft/mimalloc commit `4068384292d40fb2c8e4e323b88fc52eff6b42d6`
to the pinned v3.1.6 commit `e874dbe8d7f248561dd9a65d2e07a204b93af067`.
The upstream source is MIT licensed; its existing license remains with the
fetched dependency.

Freed arena ranges at or above `MI_LARGE_PAGE_SIZE` (4 MiB on 64-bit) purge
immediately. Smaller ranges keep their existing delayed reuse. Explicitly
disabled purging, pinned memory and preload guards are unchanged. The added
`MIMALLOC_ARENA_PURGE_IMMEDIATE_SIZE` option uses upstream KiB semantics.
The backport excludes unrelated option renames, new APIs and build changes.

Remove this patch when adopting an upstream version containing the fix.
