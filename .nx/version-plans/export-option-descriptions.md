---
libassimp: patch
---

Every export option in `libassimp/capabilities` now has a plain description that reads as help text in a settings form. Options that were described only by their Assimp config key, such as 3MF `unit` (`3MF_EXPORT_UNIT.`) and OBJ and FBX `joinIdenticalVertices` (`bJoinIdenticalVertices.`), now say what they do, and the long Assimp comments on `pointClouds`, the glTF options and the USD options are rewritten to say what each one changes in the output. Export option descriptions are now authored in the override ledger and published verbatim, so an engine update can no longer replace them with Doxygen text. Generation fails when an export option has no authored description.
