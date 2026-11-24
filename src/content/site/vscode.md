---
title: "Titan for VS Code & Language Server"
description: "Self-contained VS Code extension and standalone stdio Language Server for Titan, written in Titan."
---

# Titan for VS Code & Language Server

[`vscode-titan`](https://github.com/mascarenhas/vscode-titan) provides both the VS Code extension and the standalone stdio language server (`titan-language-server`) for the [Titan programming language](/book/). The server is written in Titan (~30,000 lines) and speaks standard `Content-Length`-framed JSON-RPC over stdio.

A target-specific VSIX is self-contained for ordinary native and browser editing: it bundles the statically linked `titan-language-server` executable (Titan runtime, embedded Lua 5.5, libuv, llhttp, SQLite, and metadata-only standard interfaces), compatible `titan-compiler` Lua modules, SDK headers, Lua sources, and the matching browser semantic pack.

## Capabilities

- **Syntax highlighting** for `.titan` files, including `foreign` types and unprefixed C types inside `foreign function` declarations.
- **Saved-file semantic intelligence:** go-to-definition, references, rename (with shorthand-preserving multi-part union rename), folding, hover, and compiler diagnostics in **Problems**.
- **Unsaved-buffer completion** triggered by `.` and `:` (with named callable signatures and editable call placeholders) and live hover following edits after completion.
- **LDoc documentation** in hover and completion, with links into [The Titan Programming Language](/book/modules/#documentation-comments).
- **Native and browser targets** (`target = "browser"`) typechecked cleanly in separate roots of one workspace.
- **Foreign C namespaces:** module-local hover and references for `foreign import` C namespaces (`ffi`).

## Quick Start: VS Code Extension

Install a platform VSIX (or build one from source with `make package install-vsix`) and open any trusted workspace folder containing `.titan` files:

```sh
code --install-extension .build/vsix/titan-linux-x64.vsix --force
```

Projects default to `./src` and `target = "native"`. Add an optional `titan-config.lua` at the workspace root to configure source roots, C include directories, or the browser target:

```lua
-- titan-config.lua (optional global assignments; paths resolve from root)
include = { "./src", "./tests" }
source_module_roots = { "./src", "./tests" }
target = "native" -- or "browser"
extra_ffi_include_dirs = { "./include" }
```

## Quick Start: Standalone Language Server

Build and install `titan-language-server` for Neovim, Helix, `omp`, Codex, or any LSP client:

```sh
make -j2 server
make install-server INSTALL_PREFIX="$HOME/.local"
```

Point `TITAN_ROOT` at your matching installed Titan SDK (`$PREFIX` from the installation guide):

```sh
export TITAN_ROOT="$PREFIX" # e.g. "$HOME/.local/titan/my-project"
export TITAN_LS_LUA_PATH="$TITAN_ROOT/share/lua/5.5/?.lua;$TITAN_ROOT/share/lua/5.5/?/init.lua"
export TITAN_LS_LUA_CPATH="$TITAN_ROOT/lib/lua/5.5/?.so"
```

## Documentation Map

### User Guides

| Guide | Covers |
| --- | --- |
| [Using the Titan VS Code Extension](/vscode/vscode-extension/) | VSIX installation, editing features, `titan-config.lua`, extension settings, multi-root/symlink/remote workspaces, logs, `.titan-ls` cache, Windows notes |
| [Using the Standalone Language Server](/vscode/language-server/) | `titan-language-server` CLI install, compiler discovery, LSP initialization options, multi-root routing, per-root SDKs and trust, `omp` setup, probe cache layout |
| [Codex Plugin and Query Client](/vscode/codex/) | Repository marketplace setup, `titan-lsp-query.mjs` one-shot JSON CLI, sandbox escalation, exit codes |

### Inside `vscode-titan` (Architecture Book)

Read [*Inside `vscode-titan`: Building a Language Server in Titan*](/vscode/architecture/) for the complete 6-chapter architectural deep dive covering [process routing](/vscode/server-data-flow/), [JSON-RPC framing & cooperative concurrency](/vscode/protocol-and-concurrency/), [crossing the Lua and C compiler bridge](/vscode/compiler-bridge/), [incremental SQLite indexing](/vscode/sqlite-backend-storage/), [saved-file semantic features](/vscode/semantic-features/), and [unsaved-buffer completion](/vscode/completion/), plus engineering appendices on [native builds & packaging](/vscode/native-build/), [executable coverage](/vscode/coverage/), and [benchmarks](/vscode/benchmarks/).
