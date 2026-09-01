# Portable Windows build — DO NOT bake in -march=native.
#
# whisper.cpp/ggml default GGML_NATIVE=ON, which compiles for the *build* machine's
# exact CPU. GitHub's windows-latest runners are frequently AVX-512-capable (Xeon
# Cascade/Ice Lake), so the shipped pluely.exe then contains AVX-512 (EVEX) kernels.
# Any user CPU without AVX-512 — Intel Comet Lake (i5-10500T), most consumer chips,
# AMD pre-Zen4 — hits STATUS_ILLEGAL_INSTRUCTION (0xc000001d) the instant whisper
# runs its first transcription pass, and Windows kills the app. The crash is
# intermittent across releases only because the runner hardware varies build to build.
#
# Forcing GGML_NATIVE OFF makes ggml fall back to its explicit instruction-set
# options: GGML_AVX and GGML_AVX2 default ON, GGML_AVX512* default OFF. The result
# runs on any x86-64 CPU with AVX2 (essentially everything from ~2013 on) — which
# includes every machine Robert targets — at no meaningful speed cost for whisper.
#
# This file is injected as CMAKE_TOOLCHAIN_FILE (see .github/workflows/windows.yml).
# Setting the cache entry FORCE here, before ggml's option(GGML_NATIVE ...) runs,
# makes that option() a no-op so the value sticks. It touches nothing else, so it is
# inert for any other CMake dependency in the build graph.
set(GGML_NATIVE OFF CACHE BOOL "portable build: no -march=native (avoids AVX-512)" FORCE)

# Match the static C runtime (/MT) that sherpa-onnx's prebuilt static libs use, so
# whisper.cpp's cmake build doesn't collide with them on the CRT (LNK2038/2005).
# Paired with RUSTFLAGS=-C target-feature=+crt-static in the workflow.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "static CRT to match sherpa-onnx" FORCE)
