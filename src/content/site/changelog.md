---
title: "Changelog"
description: "Release notes and milestones for the Titan programming language."
---

# Changelog

Release highlights for the [Titan programming language](https://github.com/mascarenhas/titan/releases). See the [Installation Guide](/book/installation/) for prefix layout and upgrade rules.

## v0.6.1

*Tag: [`v0.6.1`](https://github.com/mascarenhas/titan/releases/tag/v0.6.1) · Commit `704d481`*

- **Library-series artifact compatibility:** Compiled native providers, browser `analysis-target` descriptors and semantic companion packs, and saved language-server project manifests now check compatibility by Titan library series (`0.6`) rather than exact patch number, keeping patch upgrades drop-in compatible whenever ABI, artifact format versions, and the pinned Emscripten version are unchanged.
- **Relocation and POSIX path robustness:** Decoded C `#line` control string literals during relocation and preserved POSIX backslash filenames in compiler inputs.
- **Windows OpenSSL DLL discovery:** Automatically discovers and stages the exact `libcrypto` / `libssl` DLL basenames referenced by the active MSYS2 OpenSSL import libraries (supporting both OpenSSL 3 and OpenSSL 4 SDKs).

## v0.6.0

*Tag: [`v0.6.0`](https://github.com/mascarenhas/titan/releases/tag/v0.6.0) · Commit `bf85a3a`*

- **Browser WebAssembly target (`--target browser`):** Complete Emscripten compilation target shipping 21 standard library modules (including browser `io`, `os`, `lua`, `http` fetch client, `websocket` client, and browser-only `titan.browser` JavaScript bridge), source-attributed Wasm traces, Windows-host browser builds, and tool-free semantic companion packs for the language server.
- **Networking, HTTP, and PEG improvements:**
  - `net` and `ssl`: immutable `net.Address` snapshots from `Server:local_address` and `Connection:local_address` / `peer_address`, and default `TCP_NODELAY` with `Connection:set_no_delay`.
  - `http`: `Server:local_address`, `Request:local_address` / `peer_address`, `Response:is_committed`, header+first-body write coalescing, and skipped unread-body drains on non-reusable exchanges.
  - `peg`: cached wrapped match programs per `Pattern` to avoid recompiling LPegLabel wrappers on every `match` call.
- **Packaging and static composition:** First-class LuaRocks library module publishing (`titan-install`, per-module `titan-uninstall`, installed-source fallback), paired `.so`/`.a` outputs, static archive import closure for `--static` executables, and source-backed nominal recovery from compiled providers for semantic clients.
- **Type system and FFI refinements:** Maybe-const Arrays (`const? { T }`), preserved generic container views across erased boundaries, structured foreign function body grammar with zeroed automatic locals, Clang 23 `#line` literal compatibility, and hosted GitHub Actions CI across Linux, macOS, and Windows.
- **Reorganized documentation:** Complete rewrite of [The Titan Programming Language](/book/) (Parts I–IV, 27 standard library module chapters, Appendices A–D) and the [Effective Titan Style Guide](/book/style-guide/).
