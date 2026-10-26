---
libassimp: patch
---

The Linux native addon allocates through mimalloc and links libstdc++ statically, which makes large conversions about 8–14% faster with byte-identical output, for 2–4% more peak memory. The addon no longer depends on the system `libstdc++.so.6`.
