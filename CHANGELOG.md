# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-18

First standalone release, split out of the creature viewer in KiwiAPI.

### Added

- Blueprint (v3, v4, v5) and `.tmod` reading in the browser, with no server.
- Placement from the game's prefab bindings, matching the reference server's results exactly.
- 325 rigs, 3,254 animation clips and 261 animation graphs built in.
- Rig browsing with attach-point markers, game creatures from an extracted `blueprints` folder, and rigs loaded from a folder.
- `trove-gr.exe`, the Granny decoder in `tools/granny`, which rebuilds the rigs straight from a Trove install.
