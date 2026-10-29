---
libassimp: patch
---

Every export option in `libassimp/capabilities` now has a plain description that reads as help text in a settings form. Options that were described only by their Assimp config key, such as 3MF `unit` (`3MF_EXPORT_UNIT.`) and OBJ and FBX `joinIdenticalVertices` (`bJoinIdenticalVertices.`), now say what they do, and the long Assimp comments on `pointClouds`, the glTF options and the USD options are rewritten to say what each one changes in the output. Generation now fails when an export option's description is a bare config key.
