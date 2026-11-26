#!/usr/bin/env bash
# Reproducible single-threaded, MEMFS build of Binaryen's `wasm-opt` for the
# playground's Compiler Worker (browsers without cross-origin isolation) and
# for Node CI. Titan browser images need Binaryen's real `--stack-check`
# instrumentation (`__set_stack_limits`) and DWARF-preserving optimization
# (`--debuginfo`), and Binaryen's published Node build uses pthreads and
# NODERAWFS, which neither a non-isolated page nor a module Worker can run.
#
# The build follows upstream's own `BUILD_FOR_BROWSER` recipe
# (CMakeLists.txt: `-sENVIRONMENT=web,worker`, `-sINVOKE_RUN=0`,
# `-sEXPORTED_RUNTIME_METHODS=run,callMain,FS`, `-sEXPORT_ES6`, MEMFS) with two
# deliberate edits to upstream's CMakeLists.txt:
#   * the environment also admits `node`, so `scripts/verify-examples.mjs`
#     runs the very artifact the browser loads; and
#   * full LLVM DWARF support stays ON. Upstream forces it OFF for Emscripten
#     builds "for size"; without it `--debuginfo` cannot rewrite the
#     `.debug_line` tables that `browsertrace.lua` turns into the image's
#     trace table.
#
# Usage: scripts/build-wasm-opt.sh <work-dir> <output-dir>
# Environment: EMSDK (default ~/.local/emsdk), CMAKE (default `cmake`),
# JOBS (default `nproc`).
#
# The output is byte-reproducible: the playground manifest hashes these bytes,
# so the Emscripten release is pinned exactly (another release emits other
# code) and source, build and SDK directories are prefix-mapped out of the
# assertion strings Binaryen keeps in release builds.
set -euo pipefail

BINARYEN_TAG=version_133
BINARYEN_COMMIT=fba5005a132d85d578be5bd010e0487ed8e2ce3e
EMSCRIPTEN_VERSION=6.0.13

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <work-dir> <output-dir>" >&2
  exit 2
fi
work=$(realpath -m "$1")
out=$(realpath -m "$2")
emsdk=$(realpath "${EMSDK:-$HOME/.local/emsdk}")
cmake_bin=${CMAKE:-cmake}
jobs=${JOBS:-$(nproc)}
emcmake="$emsdk/upstream/emscripten/emcmake"
emcc="$emsdk/upstream/emscripten/emcc"
[ -x "$emcmake" ] || { echo "missing $emcmake (set EMSDK)" >&2; exit 1; }
emscripten_version=$(tr -d '"\n' < "$emsdk/upstream/emscripten/emscripten-version.txt")
if [ "$emscripten_version" != "$EMSCRIPTEN_VERSION" ]; then
  echo "Emscripten $emscripten_version found, $EMSCRIPTEN_VERSION required" >&2
  echo "(emsdk install $EMSCRIPTEN_VERSION && emsdk activate $EMSCRIPTEN_VERSION)" >&2
  exit 1
fi

src="$work/binaryen"
build="$work/build"
mkdir -p "$work" "$out"

if [ ! -d "$src/.git" ]; then
  git clone --depth 1 --branch "$BINARYEN_TAG" --recurse-submodules --shallow-submodules \
    https://github.com/WebAssembly/binaryen.git "$src"
fi
actual=$(git -C "$src" rev-parse HEAD)
if [ "$actual" != "$BINARYEN_COMMIT" ]; then
  echo "binaryen $BINARYEN_TAG resolved to $actual, expected $BINARYEN_COMMIT" >&2
  exit 1
fi

# Each edit replaces (or deletes) one exact upstream line of a clean
# CMakeLists.txt and is verified both ways.
cmakelists="$src/CMakeLists.txt"
git -C "$src" checkout -- CMakeLists.txt
patch_line() {
  local from=$1 to=$2
  grep -qxF -- "$from" "$cmakelists" || {
    echo "upstream line not found, recheck the patch: $from" >&2
    exit 1
  }
  FROM=$from TO=$to perl -0pi -e 's/^\Q$ENV{FROM}\E\n/$ENV{TO} eq "" ? "" : "$ENV{TO}\n"/me' "$cmakelists"
  if grep -qxF -- "$from" "$cmakelists"; then
    echo "failed to patch: $from" >&2
    exit 1
  fi
}
patch_line '  set(BUILD_LLVM_DWARF OFF)' ''
patch_line '    add_link_flag("-sENVIRONMENT=web,worker")' '    add_link_flag("-sENVIRONMENT=web,worker,node")'

prefix_maps="-ffile-prefix-map=$src=/binaryen -ffile-prefix-map=$build=/build -ffile-prefix-map=$emsdk=/emsdk"
"$emcmake" "$cmake_bin" -S "$src" -B "$build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  "-DCMAKE_C_FLAGS=$prefix_maps" \
  "-DCMAKE_CXX_FLAGS=$prefix_maps" \
  -DBUILD_FOR_BROWSER=ON \
  -DBUILD_LLVM_DWARF=ON \
  -DBUILD_TESTS=OFF \
  -DEMSCRIPTEN_ENABLE_PTHREADS=OFF \
  -DEMSCRIPTEN_ENABLE_WASM_EH=ON \
  -DENABLE_WERROR=OFF
"$cmake_bin" --build "$build" --target wasm-opt -j "$jobs"

if grep -qaF -e "$src" -e "$build" -e "$emsdk" "$build/bin/wasm-opt.wasm" "$build/bin/wasm-opt.js"; then
  echo "wasm-opt output still names a build directory" >&2
  exit 1
fi
cp "$build/bin/wasm-opt.js" "$build/bin/wasm-opt.wasm" "$out/"
cp "$src/LICENSE" "$out/LICENSE"
# wasm-opt.js is Emscripten's runtime and wasm-opt.wasm links its system
# libraries; their notices travel with the artifact.
emscripten_root="$emsdk/upstream/emscripten"
mkdir -p "$out/emscripten"
cp "$emscripten_root/LICENSE" "$out/emscripten/emscripten-LICENSE.txt"
cp "$emscripten_root/system/lib/libc/musl/COPYRIGHT" "$out/emscripten/musl-COPYRIGHT.txt"
for library in libcxx libcxxabi libunwind compiler-rt; do
  cp "$emscripten_root/system/lib/$library/LICENSE.TXT" "$out/emscripten/$library-LICENSE.txt"
done
{
  printf '{\n'
  printf '  "binaryen": "%s",\n' "$BINARYEN_TAG"
  printf '  "commit": "%s",\n' "$BINARYEN_COMMIT"
  printf '  "emscripten": "%s",\n' "$("$emcc" --version | head -n 1 | sed 's/"/\\"/g')"
  printf '  "wasm-opt.js": "%s",\n' "$(sha256sum "$out/wasm-opt.js" | cut -d' ' -f1)"
  printf '  "wasm-opt.wasm": "%s"\n' "$(sha256sum "$out/wasm-opt.wasm" | cut -d' ' -f1)"
  printf '}\n'
} > "$out/wasm-opt.json"
echo "wrote $out/wasm-opt.js, $out/wasm-opt.wasm, $out/wasm-opt.json"
