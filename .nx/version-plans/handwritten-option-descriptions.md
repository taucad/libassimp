---
libassimp: minor
---

Replace every import and export option description in `libassimp/capabilities` with handwritten help text that says what the option does, in plain sentences without engine macro names, config keys or Doxygen markup. Descriptions that misstated the engine's behaviour are corrected, and options the engine reads but ignores now say so.

Breaking: `DescribedOptionDescriptor.description` is optional. Options whose name already says what they do, such as `binary`, `animations` and the FBX `importFbxRead*` switches, have no `description` key. Show the option name alone when it is absent.
