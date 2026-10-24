---
libassimp: patch
---

The Linux native addon allocates through mimalloc and links libstdc++ statically, which makes large conversions about 10–13% faster with byte-identical output. The addon no longer depends on the system `libstdc++.so.6`.
