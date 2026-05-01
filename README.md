# C++ Flow Studio

Interactive front-end plus a local LLDB-backed trace server for a modern C++ execution visualizer.

## What this build includes

- Code editor for writing or pasting C++ snippets
- Step-by-step execution playback with previous and next navigation
- Function stack visualization with per-variable hide controls
- Recursion flow panel for nested calls
- Container renderers for `vector`, `map`, and `set`
- Focused UI that prefers changed state over noisy state
- Clean animated history so earlier steps remain inspectable

## How to run it

From this folder, start the local server:

```bash
python3 server.py
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Current scope

This version is built around your own code input:

- Real tracing through `clang++` + `lldb`, returning step-by-step source-line execution for the C++ you paste into the editor
- No preset-driven workflow

## What works now

- Step-by-step line tracing for your pasted C++ code
- Real call-stack depth from LLDB
- Active-frame local variable capture
- Real container snapshots for `vector`, `map`, and `set`
- Previous/next navigation and playback in the UI

## Best next step

The next milestone is trace fidelity:

1. Improve caller-frame locals and argument capture beyond the active frame.
2. Add smarter filtering for uninitialized values and noisy library frames.
3. Expand container rendering to more STL types and nested structures.
4. Add breakpoint controls and optional user-selected watch variables.
