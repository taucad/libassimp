---
libassimp: patch
---

The Wasm build uses dlmalloc instead of mimalloc: the binary is 60 kB smaller and large conversions reach a 12–52% lower linear-memory high-water mark at the same speed, which leaves more of the 4 GiB limit for the input. The native addon is built with link-time optimization, shrinking it from 30.5 MB to about 19 MB.
