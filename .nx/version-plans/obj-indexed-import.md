---
libassimp: patch
---

OBJ files import as indexed meshes: face corners that share a position, texture coordinate and normal share one vertex. Converting a 1024 × 1024 OBJ grid to GLB peaks about 19% lower in memory with byte-identical output. Face-normal generation no longer reads past the end of a mesh's texture coordinates, colours or tangents when it splits a shared vertex.
