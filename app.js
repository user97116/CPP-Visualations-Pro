const dom = {
  runVisualizer: document.querySelector("#run-visualizer"),
  codeEditor: document.querySelector("#code-editor"),
  filterUnchanged: document.querySelector("#filter-unchanged"),
  focusMode: document.querySelector("#focus-mode"),
  traceTitle: document.querySelector("#trace-title"),
  stepIndicator: document.querySelector("#step-indicator"),
  lineIndicator: document.querySelector("#line-indicator"),
  eventIndicator: document.querySelector("#event-indicator"),
  execBanner: document.querySelector("#exec-banner"),
  execBannerLine: document.querySelector("#exec-banner-line"),
  execBannerCode: document.querySelector("#exec-banner-code"),
  execBannerEvent: document.querySelector("#exec-banner-event"),
  surfaceStackCount: document.querySelector("#surface-stack-count"),
  surfaceFlowCount: document.querySelector("#surface-flow-count"),
  surfaceContainerCount: document.querySelector("#surface-container-count"),
  surfaceFocus: document.querySelector("#surface-focus"),
  containerContextLabel: document.querySelector("#container-context-label"),
  stepSlider: document.querySelector("#step-slider"),
  stepSummary: document.querySelector("#step-summary"),
  codeVisual: document.querySelector("#code-visual"),
  codeMapVisual: document.querySelector("#code-map-visual"),
  stackView: document.querySelector("#stack-view"),
  flowView: document.querySelector("#flow-view"),
  toggleFlowGraph: document.querySelector("#toggle-flow-graph"),
  toggleFlowList: document.querySelector("#toggle-flow-list"),
  memoryView: document.querySelector("#memory-view"),
  containersView: document.querySelector("#containers-view"),
  visualizeAddresses: document.querySelector("#visualize-addresses"),
  prevStep: document.querySelector("#prev-step"),
  nextStep: document.querySelector("#next-step"),
  playPause: document.querySelector("#play-pause"),
  programOutput: document.querySelector("#program-output"),
  outputBadge: document.querySelector("#output-badge")
};

const state = {
  trace: null,
  stepIndex: 0,
  playing: false,
  playTimer: null,
  hiddenVariables: new Set(),
  hiddenFrames: new Set(),
  isLoading: false,
  memoryFrozen: false,
  memoryStepIndex: 0,
  showFlowGraph: true,
  showFlowList: true
};

initialize();

function initialize() {
  dom.codeEditor.placeholder = [
    "#include <iostream>",
    "",
    "int main() {",
    "    int x = 5;",
    "    std::cout << x << \"\\n\";",
    "    return 0;",
    "}"
  ].join("\n");
  dom.runVisualizer.addEventListener("click", runVisualization);
  dom.prevStep.addEventListener("click", () => moveStep(-1));
  dom.nextStep.addEventListener("click", () => moveStep(1));
  dom.playPause.addEventListener("click", togglePlayback);
  dom.stepSlider.addEventListener("input", (event) => {
    state.stepIndex = Number(event.target.value);
    render();
  });
  dom.filterUnchanged.addEventListener("change", render);
  dom.focusMode.addEventListener("change", render);
  dom.visualizeAddresses.addEventListener("click", () => {
    state.memoryFrozen = !state.memoryFrozen;
    state.memoryStepIndex = state.stepIndex;
    dom.visualizeAddresses.textContent = state.memoryFrozen ? "Live view" : "Visualize";
    render();
  });
  dom.toggleFlowGraph.addEventListener("click", () => {
    state.showFlowGraph = !state.showFlowGraph;
    dom.toggleFlowGraph.textContent = state.showFlowGraph ? "Hide graph" : "Show graph";
    render();
  });
  dom.toggleFlowList.addEventListener("click", () => {
    state.showFlowList = !state.showFlowList;
    dom.toggleFlowList.textContent = state.showFlowList ? "Hide details" : "Show details";
    render();
  });

  render();
}

async function runVisualization() {
  const code = dom.codeEditor.value;
  if (!code.trim()) {
    state.trace = null;
    stopPlayback();
    dom.traceTitle.textContent = "Code required";
    dom.eventIndicator.textContent = "Nothing to trace";
    dom.stepSummary.textContent = "Paste or write C++ code in the editor before running the visualization.";
    render();
    return;
  }

  state.isLoading = true;
  state.hiddenVariables.clear();
  state.hiddenFrames.clear();
  stopPlayback();
  dom.runVisualizer.disabled = true;
  dom.runVisualizer.textContent = "Tracing...";
  dom.traceTitle.textContent = "Compiling and tracing";
  dom.eventIndicator.textContent = "LLDB backend running";
  dom.stepSummary.textContent = "Building your C++ code and capturing source-line execution data.";

  try {
    const response = await fetch("/api/trace", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ code })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.details ? `${payload.error}\n${payload.details}` : payload.error);
    }

    state.trace = payload;
    const out = (payload.stdout ?? "").trim();
    if (out) {
      dom.programOutput.textContent = out;
      dom.programOutput.className = "output-pre";
      dom.outputBadge.textContent = `${out.split("\n").length} line${out.split("\n").length !== 1 ? "s" : ""}`;
    } else {
      dom.programOutput.textContent = "No output produced.";
      dom.programOutput.className = "output-pre empty";
      dom.outputBadge.textContent = "stdout";
    }
  } catch (error) {
    state.trace = null;
    dom.traceTitle.textContent = "Trace failed";
    dom.eventIndicator.textContent = "Backend or compile error";
    dom.stepSummary.textContent = error.message || "The trace could not be generated.";
    dom.programOutput.textContent = "No output.";
    dom.programOutput.className = "output-pre empty";
    dom.outputBadge.textContent = "stdout";
    window.console.error(error);
  } finally {
    state.isLoading = false;
    state.stepIndex = 0;
    dom.stepSlider.max = Math.max((state.trace?.steps.length || 1) - 1, 0);
    dom.stepSlider.value = "0";
    dom.runVisualizer.disabled = false;
    dom.runVisualizer.textContent = "Run visualization";
    render();
  }
}

function togglePlayback() {
  if (!state.trace || state.trace.steps.length === 0) {
    return;
  }

  if (state.playing) {
    stopPlayback();
    render();
    return;
  }

  state.playing = true;
  dom.playPause.textContent = "Pause";
  state.playTimer = window.setInterval(() => {
    if (state.stepIndex >= state.trace.steps.length - 1) {
      stopPlayback();
      render();
      return;
    }

    state.stepIndex += 1;
    dom.stepSlider.value = String(state.stepIndex);
    render();
  }, 1400);
}

function stopPlayback() {
  state.playing = false;
  window.clearInterval(state.playTimer);
  state.playTimer = null;
  dom.playPause.textContent = "Play";
}

function moveStep(delta) {
  if (!state.trace) {
    return;
  }

  stopPlayback();
  state.stepIndex = clamp(state.stepIndex + delta, 0, state.trace.steps.length - 1);
  dom.stepSlider.value = String(state.stepIndex);
  render();
}

function render() {
  const trace = state.trace;
  const step = trace?.steps?.[state.stepIndex];

  dom.traceTitle.textContent = trace ? trace.title : "Real LLDB Trace";
  dom.stepIndicator.textContent = trace ? `${state.stepIndex + 1} / ${trace.steps.length}` : "0 / 0";
  dom.lineIndicator.textContent = step ? `L${step.line}` : "-";
  dom.eventIndicator.textContent = step ? step.event : "Waiting for a run";
  dom.stepSummary.textContent = step ? step.summary : dom.stepSummary.textContent || "Write your C++ code, then run the visualization to inspect real execution flow.";
  dom.stepSlider.disabled = !trace || state.isLoading;
  dom.surfaceStackCount.textContent = String(step?.stack?.length || 0);
  dom.surfaceFlowCount.textContent = String(step?.tree?.nodes?.length || 0);
  dom.surfaceContainerCount.textContent = String(countContainers(step?.containers));
  dom.surfaceFocus.textContent = step ? `${step.event} at line ${step.line}` : "Waiting for a run";
  dom.containerContextLabel.textContent = getContainerContextLabel(step);

  if (step) {
    const lineText = trace.code.split("\n")[step.line - 1]?.trim() || "";
    dom.execBannerLine.textContent = `L${step.line}`;
    dom.execBannerCode.textContent = lineText;
    dom.execBannerEvent.textContent = step.event;
    dom.execBanner.classList.remove("exec-banner--idle");
    dom.execBanner.classList.add("exec-banner--active");
  } else {
    dom.execBannerLine.textContent = "—";
    dom.execBannerCode.textContent = "Waiting for trace";
    dom.execBannerEvent.textContent = "";
    dom.execBanner.classList.remove("exec-banner--active");
    dom.execBanner.classList.add("exec-banner--idle");
  }

  renderCode(trace, step);
  renderCodeMap(trace);
  renderStack(step);
  renderFlow(step);
  const memoryStep = trace && state.memoryFrozen ? trace.steps[state.memoryStepIndex] : step;
  renderMemory(memoryStep);
  renderContainers(step);

  if (step) {
    const out = (step.stdout ?? "").trim();
    if (out) {
      dom.programOutput.textContent = out;
      dom.programOutput.className = "output-pre";
      dom.outputBadge.textContent = `${out.split("\n").length} line${out.split("\n").length !== 1 ? "s" : ""}`;
    } else {
      dom.programOutput.textContent = "No output yet.";
      dom.programOutput.className = "output-pre empty";
      dom.outputBadge.textContent = "stdout";
    }
  }
}

function renderCode(trace, step) {
  dom.codeVisual.innerHTML = "";

  const lines = trace ? trace.code.split("\n") : dom.codeEditor.value.split("\n");
  lines.forEach((content, index) => {
    const line = document.createElement("div");
    line.className = "code-line";

    if (step) {
      if (index + 1 === step.line) {
        line.classList.add("active");
      } else if (index + 1 < step.line && dom.focusMode.checked) {
        line.classList.add("done");
      }
    }

    const lineNumber = document.createElement("span");
    lineNumber.className = "line-number";
    lineNumber.textContent = String(index + 1);

    const lineContent = document.createElement("span");
    lineContent.textContent = content || " ";

    line.append(lineNumber, lineContent);
    dom.codeVisual.append(line);
  });
}

function renderCodeMap(trace) {
  dom.codeMapVisual.innerHTML = "";
  const code = trace?.code || dom.codeEditor.value || "";
  if (!code.trim()) {
    dom.codeMapVisual.innerHTML = `<div class="empty-state">Write code in the editor to build a static call map.</div>`;
    return;
  }

  const { functions, edges } = buildCodeStructureMap(code);
  if (!functions.length) {
    dom.codeMapVisual.innerHTML = `<div class="empty-state">No function definitions matched for the code map. Try top-level functions with a trailing <code>{</code>.</div>`;
    return;
  }

  const NODE_W = 120;
  const NODE_H = 44;
  const GAP_X = 36;
  const GAP_Y = 56;
  const PAD = 24;
  const cols = Math.max(2, Math.ceil(Math.sqrt(functions.length)));
  const positions = new Map();
  functions.forEach((fn, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(fn.name, {
      x: PAD + col * (NODE_W + GAP_X) + NODE_W / 2,
      y: PAD + row * (NODE_H + GAP_Y) + NODE_H / 2
    });
  });

  const edgeSet = new Set(edges.map((e) => `${e.from}→${e.to}`));
  const edgePaths = [];
  edgeSet.forEach((key) => {
    const [from, to] = key.split("→");
    const a = positions.get(from);
    const b = positions.get(to);
    if (!a || !b) {
      return;
    }
    const x1 = a.x, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y - NODE_H / 2;
    const mid = (y1 + y2) / 2;
    edgePaths.push(`<path class="code-map-edge" d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}" />`);
  });

  const nodesSvg = functions.map((fn) => {
    const pos = positions.get(fn.name);
    if (!pos) {
      return "";
    }
    const x = pos.x, y = pos.y;
    const active = trace?.steps?.[state.stepIndex];
    const onStack = active?.stack?.some((f) => f.name === fn.name);
    const cls = onStack ? "code-map-node code-map-node--hot" : "code-map-node";
    return `
      <g class="${cls}" transform="translate(${x},${y})">
        <rect x="${-NODE_W / 2}" y="${-NODE_H / 2}" rx="10" ry="10" width="${NODE_W}" height="${NODE_H}" />
        <text y="-4" text-anchor="middle" class="code-map-name">${escapeHtml(fn.name)}</text>
        <text y="12" text-anchor="middle" class="code-map-params">${escapeHtml(fn.paramsShort)}</text>
        <title>${escapeHtml(`${fn.name}(${fn.params})`)}</title>
      </g>`;
  }).join("");

  const width = PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X;
  const rows = Math.ceil(functions.length / cols);
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y;

  dom.codeMapVisual.innerHTML = `
    <div class="code-map-scroll">
      <svg class="code-map-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
        <g class="code-map-lines">${edgePaths.join("")}</g>
        <g class="code-map-nodes">${nodesSvg}</g>
      </svg>
    </div>`;
}

function buildCodeStructureMap(code) {
  const declRe = /^\s*(?:template\s*<[^>]+>\s*)?(?:inline\s+|static\s+|constexpr\s+)*(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:[\w:<>,\s]+\s+)+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?\{/gm;
  const functions = [];
  let match;
  while ((match = declRe.exec(code)) !== null) {
    const name = match[1];
    const params = match[2].trim();
    if (name === "if" || name === "for" || name === "while" || name === "switch") {
      continue;
    }
    const paramsShort = params.length > 22 ? `${params.slice(0, 21)}…` : params;
    functions.push({ name, params, paramsShort, start: match.index });
  }

  functions.sort((a, b) => a.start - b.start);
  const names = new Set(functions.map((f) => f.name));
  const edges = [];
  for (let i = 0; i < functions.length; i += 1) {
    const fn = functions[i];
    const end = i + 1 < functions.length ? functions[i + 1].start : code.length;
    const slice = code.slice(fn.start, end);
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
    let cm;
    const seen = new Set();
    while ((cm = callRe.exec(slice)) !== null) {
      const callee = cm[1];
      if (callee === fn.name) {
        continue;
      }
      if (!names.has(callee)) {
        continue;
      }
      if (seen.has(callee)) {
        continue;
      }
      seen.add(callee);
      edges.push({ from: fn.name, to: callee });
    }
  }

  return { functions, edges };
}

function renderStack(step) {
  dom.stackView.innerHTML = "";

  if (!step?.stack?.length) {
    dom.stackView.innerHTML = `<div class="empty-state">Run a trace to inspect function frames, locals, and return values.</div>`;
    return;
  }

  step.stack.forEach((frame, index) => {
    const frameCard = document.createElement("div");
    frameCard.className = `stack-frame ${frame.active ? "active" : ""}`;
    const frameHidden = state.hiddenFrames.has(frame.id);

    const args = frame.args?.length ? frame.args.join(", ") : "no arguments";
    const variables = [...(frame.locals || []), ...(frame.returnValue !== undefined ? [{
      name: "return",
      value: frame.returnValue,
      changed: true,
      isReturn: true
    }] : [])];

    const visibleVariables = variables.filter((variable) => {
      const key = getVariableKey(frame.id, variable.name);
      if (state.hiddenVariables.has(key)) {
        return true;
      }
      return !dom.filterUnchanged.checked || variable.changed || variable.isReturn;
    });

    frameCard.innerHTML = `
      <div class="stack-frame-header">
        <div class="stack-frame-title">
          <span class="frame-index">${index + 1}</span>
          <div>
            <strong>${frame.name}</strong>
            <div class="frame-meta">${args}</div>
          </div>
        </div>
        <div class="frame-actions">
          <span class="frame-meta frame-status">${frame.status}</span>
          <button class="frame-toggle">${frameHidden ? "Show fn" : "Hide fn"}</button>
        </div>
      </div>
    `;

    frameCard.querySelector(".frame-toggle").addEventListener("click", () => {
      toggleFrame(frame.id);
    });

    if (frameHidden) {
      const collapsed = document.createElement("div");
      collapsed.className = "empty-state";
      collapsed.textContent = `${frame.name} hidden from the stack surface.`;
      frameCard.append(collapsed);
      dom.stackView.append(frameCard);
      return;
    }

    if (!variables.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = frame.active
        ? "No visible locals in the active frame at this step."
        : "Frame kept for call-stack flow. Local values are not expanded for this waiting frame.";
      frameCard.append(empty);
      dom.stackView.append(frameCard);
      return;
    }

    const variableGrid = document.createElement("div");
    variableGrid.className = "variables-grid";

    if (visibleVariables.length === 0) {
      variableGrid.innerHTML = `<div class="empty-state">No high-signal variables in this frame right now.</div>`;
    } else {
      visibleVariables.forEach((variable) => {
        const row = document.createElement("div");
        row.className = "variable-row";

        const variableKey = getVariableKey(frame.id, variable.name);
        const hidden = state.hiddenVariables.has(variableKey);
        const chip = document.createElement("div");
        chip.className = `variable-chip ${variable.changed ? "changed" : ""}`;
        const typeLine = variable.type
          ? `<div class="variable-type" title="${escapeHtml(variable.type)}">${escapeHtml(shortType(variable.type))}</div>`
          : "";
        chip.innerHTML = hidden
          ? `<div class="hidden-variable">${variable.name} hidden</div>`
          : `
            <div class="variable-name">${variable.name}</div>
            ${typeLine}
            <div class="variable-value">${formatValue(variable.value)}</div>
          `;

        const button = document.createElement("button");
        button.className = "hide-button";
        button.textContent = hidden ? "Show" : "Hide";
        button.addEventListener("click", () => {
          toggleVariable(frame.id, variable.name);
        });

        row.append(chip, button);
        variableGrid.append(row);
      });
    }

    frameCard.append(variableGrid);
    dom.stackView.append(frameCard);
  });
}

function renderFlow(step) {
  dom.flowView.innerHTML = "";

  const nodes = step?.tree?.nodes || [];
  const edges = step?.tree?.edges || [];

  if (!nodes.length) {
    dom.flowView.innerHTML = `<div class="empty-state">Recursion and nested call flow will appear here when detected.</div>`;
    return;
  }

  const childrenMap = new Map();
  const parentSet = new Set();
  nodes.forEach((node) => childrenMap.set(node.id, []));
  edges.forEach((edge) => {
    if (!childrenMap.has(edge.from) || !childrenMap.has(edge.to)) {
      return;
    }
    childrenMap.get(edge.from).push(edge.to);
    parentSet.add(edge.to);
  });

  const roots = nodes
    .filter((node) => !parentSet.has(node.id))
    .map((node) => node.id);

  if (roots.length === 0 && nodes.length > 0) {
    roots.push(nodes[0].id);
  }

  const NODE_W = 160;
  const NODE_H = 52;
  const PAD = 20;
  const leafXStep = NODE_W + 24;
  const levelHeight = NODE_H + 48;
  let leafCursor = 0;
  const positions = new Map();
  const visited = new Set();

  function assignNode(nodeId, depth) {
    if (visited.has(nodeId)) {
      const old = positions.get(nodeId);
      return { x: old?.x || 50, maxDepth: depth };
    }
    visited.add(nodeId);
    const children = childrenMap.get(nodeId) || [];
    if (children.length === 0) {
      const x = NODE_W / 2 + PAD + leafCursor * leafXStep;
      leafCursor += 1;
      positions.set(nodeId, { x, y: NODE_H / 2 + PAD + depth * levelHeight });
      return { x, maxDepth: depth };
    }

    const childLayouts = children.map((childId) => assignNode(childId, depth + 1));
    const minX = Math.min(...childLayouts.map((item) => item.x));
    const maxX = Math.max(...childLayouts.map((item) => item.x));
    const x = Math.round((minX + maxX) / 2);
    const maxDepth = Math.max(depth, ...childLayouts.map((item) => item.maxDepth));
    positions.set(nodeId, { x, y: NODE_H / 2 + PAD + depth * levelHeight });
    return { x, maxDepth };
  }

  let treeMaxDepth = 0;
  roots.forEach((rootId) => {
    const { maxDepth } = assignNode(rootId, 0);
    treeMaxDepth = Math.max(treeMaxDepth, maxDepth);
  });
  nodes.forEach((node) => {
    if (!positions.has(node.id)) assignNode(node.id, 0);
  });

  const width = Math.max(NODE_W + PAD * 2, PAD * 2 + leafCursor * leafXStep);
  const height = Math.max(NODE_H + PAD * 2, (treeMaxDepth + 1) * levelHeight + PAD * 2);

  const edgeSvg = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return "";
    const x1 = from.x, y1 = from.y + NODE_H / 2;
    const x2 = to.x,   y2 = to.y - NODE_H / 2;
    const cy = (y1 + y2) / 2;
    return `<path d="M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}" />`;
  }).join("");

  const nodeSvg = nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return "";
    const cls = node.active ? "flow-node active" : `flow-node${node.done ? " done" : ""}`;
    const fnName = escapeHtml(node.function || node.label);
    const paramText = Array.isArray(node.params) && node.params.length
      ? node.params.join(", ") : "";
    const compact = paramText.length > 24 ? `${paramText.slice(0, 23)}…` : paramText;
    const x = pos.x, y = pos.y;
    return `
      <g class="${cls}" transform="translate(${x},${y})">
        <rect x="${-NODE_W/2}" y="${-NODE_H/2}" rx="12" ry="12" width="${NODE_W}" height="${NODE_H}" />
        <text y="-6" text-anchor="middle" class="fn-name">${fnName}</text>
        <text y="12" text-anchor="middle" class="fn-args">${escapeHtml(compact)}</text>
        <title>${escapeHtml(`${node.label} | ${node.meta}`)}</title>
      </g>`;
  }).join("");

  const graphBlock = state.showFlowGraph
    ? `<div class="flow-svg-scroll">
        <svg class="flow-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Recursion tree">
          <g class="flow-lines">${edgeSvg}</g>
          <g class="flow-nodes">${nodeSvg}</g>
        </svg>
      </div>`
    : `<div class="empty-state">Graph section hidden. Use "Show graph" to view recursion tree.</div>`;

  const listBlock = state.showFlowList
    ? `
    <div class="flow-list">
      ${nodes.map((node) => `
        <div class="node ${node.active ? "active" : ""} ${node.done ? "done" : ""}">
          <div class="node-label">${escapeHtml(node.function || node.label)}</div>
          <div class="node-meta">${escapeHtml((node.params || []).length ? (node.params || []).join(", ") : "no params")}</div>
          <div class="node-meta">${escapeHtml(node.meta)}</div>
          <div class="node-meta node-activation">${escapeHtml(node.id)}</div>
        </div>
      `).join("")}
    </div>`
    : `<div class="empty-state">Details section hidden. Use "Show details" to expand node list.</div>`;

  dom.flowView.innerHTML = `${graphBlock}${listBlock}`;
}

function memoryMeaningfulEdgeLabel(edge) {
  const raw = (edge.label || "").trim();
  if (!raw) {
    return "";
  }
  const to = String(edge.to || "");
  if (raw === to) {
    return "";
  }
  if (raw.startsWith("0x") && to && raw.toLowerCase() === to.toLowerCase()) {
    return "";
  }
  return raw;
}

function memoryNodeByIdMap(nodes) {
  const m = new Map();
  (nodes || []).forEach((n) => {
    if (n?.id) {
      m.set(n.id, n);
    }
  });
  return m;
}

function memoryDisplayName(id, nodeById) {
  if (id == null) {
    return "?";
  }
  const sid = String(id);
  const node = nodeById.get(sid);
  if (node?.label) {
    return node.label;
  }
  if (sid.startsWith("var:")) {
    return sid.slice(4);
  }
  if (sid.startsWith("0x")) {
    const body = sid.slice(2);
    return body.length > 6 ? `0x${body.slice(0, 4)}…${body.slice(-3)}` : sid;
  }
  return sid;
}

function buildMemoryAddressMapLines(edges, nodeById) {
  const list = edges || [];
  if (!list.length) {
    return "";
  }

  const byFrom = new Map();
  for (const e of list) {
    const from = e.from;
    const to = e.to;
    if (!from || !to) {
      continue;
    }
    const lab = memoryMeaningfulEdgeLabel(e);
    if (!byFrom.has(from)) {
      byFrom.set(from, []);
    }
    const bucket = byFrom.get(from);
    const hit = bucket.find((x) => x.to === to);
    if (hit) {
      if (lab && !hit.labels.includes(lab)) {
        hit.labels.push(lab);
      }
    } else {
      bucket.push({ to, labels: lab ? [lab] : [] });
    }
  }

  const fanOut = [];
  for (const [from, targets] of byFrom) {
    if (targets.length < 2) {
      continue;
    }
    const left = memoryDisplayName(from, nodeById);
    const right = targets
      .map(({ to, labels }) => {
        const name = memoryDisplayName(to, nodeById);
        return labels.length ? `${name} (${labels.join("/")})` : name;
      })
      .join(", ");
    fanOut.push(`${left} → ${right}`);
  }
  fanOut.sort();

  const byTo = new Map();
  for (const e of list) {
    const to = e.to;
    const from = e.from;
    if (!to || !from) {
      continue;
    }
    if (!byTo.has(to)) {
      byTo.set(to, new Set());
    }
    byTo.get(to).add(from);
  }

  const fanIn = [];
  for (const [to, sources] of byTo) {
    if (sources.size < 2) {
      continue;
    }
    const left = [...sources].map((s) => memoryDisplayName(s, nodeById)).sort().join(", ");
    const right = memoryDisplayName(to, nodeById);
    fanIn.push(`${left} → ${right}`);
  }
  fanIn.sort();

  const blocks = [];
  if (fanOut.length) {
    blocks.push(
      `<div class="memory-map-section"><div class="memory-map-title">Fan-out (one → many)</div><pre class="memory-map-pre">${fanOut.map(escapeHtml).join("\n")}</pre></div>`
    );
  }
  if (fanIn.length) {
    blocks.push(
      `<div class="memory-map-section"><div class="memory-map-title">Shared target (many → one)</div><pre class="memory-map-pre">${fanIn.map(escapeHtml).join("\n")}</pre></div>`
    );
  }
  return blocks.length ? `<div class="memory-map-lines">${blocks.join("")}</div>` : "";
}

function renderMemory(step) {
  dom.memoryView.innerHTML = "";

  if (!step) {
    dom.memoryView.innerHTML = `<div class="empty-state">Run a trace to map pointer addresses as connected nodes.</div>`;
    return;
  }

  const graph = step.memory || { nodes: [], edges: [] };
  const edges = graph.edges || [];
  const nodes = graph.nodes || [];

  if (!edges.length || !nodes.length) {
    dom.memoryView.innerHTML = `<div class="empty-state">No pointer-like addresses found at this step. Try linked list or tree node pointers.</div>`;
    return;
  }

  const nodeById = memoryNodeByIdMap(nodes);
  const addressMapHtml = buildMemoryAddressMapLines(edges, nodeById);

  const CW = 168;
  const CH = 58;
  const VGAP = 88;
  const PAD = 24;
  const arrowId = `mem-arrow-${state.memoryFrozen ? state.memoryStepIndex : state.stepIndex}`;

  const varNodes = nodes.filter((n) => n.kind === "variable");
  const addrNodes = nodes.filter((n) => n.kind !== "variable");

  const incoming = new Map();
  edges.forEach((edge) => {
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, []);
    }
    incoming.get(edge.to).push(edge.from);
  });

  const varX = new Map();
  varNodes.forEach((n, i) => {
    varX.set(n.id, PAD + CW / 2 + i * (CW + 20));
  });

  const sortedAddrs = [...addrNodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const addrX = new Map();
  sortedAddrs.forEach((n, i) => {
    const sources = incoming.get(n.id) || [];
    let x;
    if (sources.length) {
      const xs = sources.map((s) => varX.get(s)).filter((v) => typeof v === "number");
      x = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : PAD + CW / 2 + i * (CW + 20);
    } else {
      x = PAD + CW / 2 + i * (CW + 20);
    }
    addrX.set(n.id, x);
  });

  const bumpOverlaps = (map, minGap) => {
    const entries = [...map.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1][1];
      const curId = entries[i][0];
      let cur = entries[i][1];
      if (cur - prev < minGap) {
        cur = prev + minGap;
        map.set(curId, cur);
        entries[i][1] = cur;
      }
    }
  };
  bumpOverlaps(varX, CW + 12);
  bumpOverlaps(addrX, CW + 12);

  const varY = PAD + CH / 2;
  const addrY = PAD + CH + VGAP + CH / 2;

  const xFor = (id) => varX.get(id) ?? addrX.get(id) ?? PAD + CW / 2;
  const yFor = (id) => (varX.has(id) ? varY : addrY);

  const maxX = Math.max(
    ...[...varX.values(), ...addrX.values()].map((x) => x + CW / 2),
    PAD + CW
  );
  const svgW = Math.max(maxX + PAD, PAD * 2 + CW);
  const svgH = addrNodes.length ? addrY + CH / 2 + PAD : varY + CH / 2 + PAD;

  const edgeSvg = edges
    .map((edge) => {
      const x1 = xFor(edge.from);
      const y1 = yFor(edge.from) + CH / 2;
      const x2 = xFor(edge.to);
      const y2 = yFor(edge.to) - CH / 2;
      if (x1 === undefined || x2 === undefined) {
        return "";
      }
      const rawLabel = edge.label || "";
      const shortLabel =
        rawLabel.startsWith("0x") && rawLabel.length > 12
          ? `${rawLabel.slice(0, 6)}…${rawLabel.slice(-4)}`
          : rawLabel;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const title = escapeHtml(`${rawLabel || "points to"} → ${edge.to}`);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${arrowId})">
          <title>${title}</title>
        </line>
        ${shortLabel ? `<text class="edge-label" x="${mx + 6}" y="${my - 4}" text-anchor="start">${escapeHtml(shortLabel)}</text>` : ""}`;
    })
    .join("");

  const renderNode = (n, x, y) => {
    const isAddr = n.kind !== "variable";
    const cls = isAddr ? "memory-node address-node" : "memory-node variable-node";
    const outs = edges.filter((e) => e.from === n.id);
    const label = escapeHtml(n.label || n.id);
    let sub = "";
    let fullTitle = `${n.label || n.id}`;
    if (!isAddr) {
      if (outs.length) {
        const parts = outs.map((out) => memoryDisplayName(out.to, nodeById));
        fullTitle = `${n.label} → ${parts.join(", ")}`;
        sub = parts.join(", ");
        if (sub.length > 30) {
          sub = `${sub.slice(0, 27)}…`;
        }
      }
    } else {
      const pb = Array.isArray(n.pointedBy) && n.pointedBy.length ? ` ← ${n.pointedBy.join(", ")}` : "";
      fullTitle = `Object @ ${n.id}${pb}`;
      const outSubs = outs.map((out) => {
        const ml = memoryMeaningfulEdgeLabel(out);
        const tn = memoryDisplayName(out.to, nodeById);
        return ml ? `${tn} (${ml})` : tn;
      });
      if (outSubs.length) {
        sub = outSubs.join(", ");
        if (sub.length > 36) {
          sub = `${sub.slice(0, 33)}…`;
        }
      } else {
        sub = n.id.length > 14 ? `${n.id.slice(0, 6)}…${n.id.slice(-4)}` : n.id;
      }
    }
    return `<g class="${cls}" transform="translate(${x},${y})">
      <title>${escapeHtml(fullTitle)}</title>
      <rect x="${-CW / 2}" y="${-CH / 2}" width="${CW}" height="${CH}" rx="10" />
      <text y="-8" text-anchor="middle" class="mem-name">${label}</text>
      <text y="12" text-anchor="middle" class="mem-val">${escapeHtml(sub)}</text>
    </g>`;
  };

  const nodesSvg = [
    ...varNodes.map((n) => renderNode(n, varX.get(n.id), varY)),
    ...addrNodes.map((n) => renderNode(n, addrX.get(n.id), addrY))
  ].join("");

  dom.memoryView.innerHTML = `
    <div class="memory-meta">${edges.length} edge${edges.length !== 1 ? "s" : ""} · ${varNodes.length} variable${varNodes.length !== 1 ? "s" : ""} · ${addrNodes.length} address${addrNodes.length !== 1 ? "es" : ""}</div>
    ${addressMapHtml}
    <div class="memory-svg-scroll">
      <svg class="memory-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" role="img" aria-label="Address graph">
        <defs>
          <marker id="${arrowId}" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="rgba(124,184,255,0.75)" />
          </marker>
        </defs>
        <g class="memory-lines">${edgeSvg}</g>
        <g>${nodesSvg}</g>
      </svg>
    </div>`;
}

function shortType(typename) {
  const t = String(typename);
  if (t.length <= 56) {
    return t;
  }
  return `${t.slice(0, 28)}…${t.slice(-24)}`;
}

function buildAdjacencySvg(edges, nameHint) {
  if (!edges.length) {
    return "";
  }
  const nodes = new Set();
  edges.forEach(([u, vs]) => {
    nodes.add(String(u));
    (Array.isArray(vs) ? vs : []).forEach((v) => nodes.add(String(v)));
  });
  const list = [...nodes];
  if (!list.length) {
    return "";
  }
  const idx = new Map(list.map((n, i) => [n, i]));
  const R = 24;
  const PAD = 24;
  const step = Math.max(80, Math.min(120, 640 / Math.max(list.length, 1)));
  const W = PAD * 2 + Math.max(list.length - 1, 0) * step + R * 2;
  const H = PAD * 2 + R * 2 + 36;
  const pos = list.map((n, i) => ({
    id: n,
    x: PAD + R + i * step,
    y: PAD + R + 8
  }));
  const markerId = `ct-arw-${Math.abs(hashString(String(nameHint) + list.join(",")))}`;
  const edgeLines = [];
  edges.forEach(([u, vs]) => {
    const a = pos[idx.get(String(u))];
    if (!a || !Array.isArray(vs)) {
      return;
    }
    vs.forEach((v) => {
      const b = pos[idx.get(String(v))];
      if (!b) {
        return;
      }
      edgeLines.push(
        `<line class="ct-adj-edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#${markerId})" />`
      );
    });
  });
  const circles = pos
    .map((p) => {
      const short = p.id.length > 8 ? `${p.id.slice(0, 7)}…` : p.id;
      return `<g class="ct-adj-node" transform="translate(${p.x},${p.y})">
        <circle r="${R}" />
        <text y="4" text-anchor="middle" class="ct-adj-label">${escapeHtml(short)}</text>
        <title>${escapeHtml(p.id)}</title>
      </g>`;
    })
    .join("");
  return `<svg class="ct-adj-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Adjacency sketch">
    <defs>
      <marker id="${markerId}" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="rgba(99,230,190,0.85)" />
      </marker>
    </defs>
    <g>${edgeLines.join("")}</g>
    <g>${circles}</g>
  </svg>`;
}

function hashString(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function createContainerDetails(name, type, typeClass, isActive) {
  const details = document.createElement("details");
  details.className = `container-card ct-${typeClass}${isActive ? " current-frame" : ""}`;
  details.open = true;
  const summary = document.createElement("summary");
  summary.className = "container-summary";
  summary.innerHTML = `<div class="container-title">
    <strong>${escapeHtml(name)}</strong>
    <span class="container-type">${escapeHtml(type)}</span>
    <span class="container-origin">${isActive ? "active frame" : "parent frame"}</span>
  </div>`;
  details.append(summary);
  return details;
}

function buildUnknownMetadataRows(unknown) {
  const kind = String(unknown.kind || "unknown");
  const rows = [
    ["name", String(unknown.name ?? "")],
    ["type", kind]
  ];
  if (unknown.address) {
    rows.push(["address", String(unknown.address)]);
  }
  const n = Array.isArray(unknown.values) ? unknown.values.length : 0;
  rows.push(["elements", String(n)]);
  return rows
    .map(
      ([k, v]) =>
        `<div class="ct-default-field"><span class="ct-default-k">${escapeHtml(k)}</span><span class="ct-default-v">${escapeHtml(v)}</span></div>`
    )
    .join("");
}

function renderContainers(step) {
  dom.containersView.innerHTML = "";

  if (!step?.stack?.length) {
    dom.containersView.innerHTML = `<div class="empty-state">Container-aware visuals show when vector, matrix (nested vectors), array, deque, map, unordered_map, set, unordered_set, stack, queue, priority_queue, list, string, or graph data is available.</div>`;
    return;
  }

  let hasAny = false;

  step.stack.forEach((frame, frameIdx) => {
    const containers = normalizeContainers(frame.containers);
    if (countContainers(containers) === 0) return;
    hasAny = true;

    const frameDetails = document.createElement("details");
    frameDetails.className = "frame-containers-details";
    frameDetails.open = Boolean(frame.active);

    const frameSummary = document.createElement("summary");
    frameSummary.className = `frame-containers-summary ${frame.active ? "active-frame-header" : ""}`;
    frameSummary.innerHTML = `
      <span class="frame-index">${frameIdx + 1}</span>
      <strong>${escapeHtml(frame.name)}</strong>
      <span class="frame-origin">${frame.active ? "active frame" : "parent frame"}</span>
      <span class="frame-expand-hint">Collections — click to expand</span>
    `;
    frameDetails.append(frameSummary);

    const content = document.createElement("div");
    content.className = "frame-containers-content";

    // Arrays: vector, deque, string, std::array, matrix (vector<vector<…>>)
    containers.arrays.forEach((array) => {
      const typeClass = array.kind || "vector";
      const card = createContainerDetails(array.name, typeClass, typeClass, frame.active);
      if (array.kind === "matrix") {
        const wrap = document.createElement("div");
        wrap.className = "ct-matrix-wrap";
        const rows = Array.isArray(array.values) ? array.values : [];
        if (!rows.length) {
          wrap.innerHTML = `<span class="ct-empty">empty matrix</span>`;
        } else {
          const colCount = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
          const table = document.createElement("div");
          table.className = "ct-matrix-grid";
          table.style.setProperty("--ct-matrix-cols", String(Math.max(colCount, 1)));
          rows.forEach((row, ri) => {
            const cells = Array.isArray(row) ? row : [];
            for (let ci = 0; ci < colCount; ci += 1) {
              const cell = document.createElement("div");
              cell.className = "ct-matrix-cell";
              const v = cells[ci];
              const empty = ci >= cells.length;
              cell.innerHTML = empty
                ? `<div class="ct-matrix-coord">[${ri},${ci}]</div><div class="ct-val ct-matrix-pad">—</div>`
                : `<div class="ct-matrix-coord">[${ri},${ci}]</div><div class="ct-val">${escapeHtml(formatValue(v))}</div>`;
              table.append(cell);
            }
          });
          wrap.append(table);
        }
        card.append(wrap);
        content.append(card);
        return;
      }
      const grid = document.createElement("div");
      grid.className = "ct-array-grid";
      if (!array.values.length) {
        grid.innerHTML = `<span class="ct-empty">empty</span>`;
      } else {
        array.values.forEach((value, i) => {
          const cell = document.createElement("div");
          cell.className = "ct-array-cell";
          cell.innerHTML = `<div class="ct-idx">[${i}]</div><div class="ct-val">${escapeHtml(formatValue(value))}</div>`;
          grid.append(cell);
        });
      }
      card.append(grid);
      content.append(card);
    });

    // Maps
    containers.maps.forEach((map) => {
      const card = createContainerDetails(map.name, map.kind || "map", "map", frame.active);
      const table = document.createElement("div");
      table.className = "ct-map-table";
      if (!map.entries.length) {
        table.innerHTML = `<span class="ct-empty">empty</span>`;
      } else {
        map.entries.forEach(([key, value]) => {
          const row = document.createElement("div");
          row.className = "ct-map-row";
          row.innerHTML = `<span class="ct-map-key">${escapeHtml(formatValue(key))}</span>
            <span class="ct-map-arrow">→</span>
            <span class="ct-map-val">${escapeHtml(formatValue(value))}</span>`;
          table.append(row);
        });
      }
      card.append(table);
      content.append(card);
    });

    // Sets
    containers.sets.forEach((set) => {
      const card = createContainerDetails(set.name, set.kind || "set", "set", frame.active);
      const wrap = document.createElement("div");
      wrap.className = "ct-set-wrap";
      if (!set.values.length) {
        wrap.innerHTML = `<span class="ct-empty">empty</span>`;
      } else {
        set.values.forEach((v) => {
          const chip = document.createElement("span");
          chip.className = "ct-set-chip";
          chip.textContent = formatValue(v);
          wrap.append(chip);
        });
      }
      card.append(wrap);
      content.append(card);
    });

    // Stacks
    containers.stacks.forEach((stack) => {
      const card = createContainerDetails(stack.name, "stack", "stack", frame.active);
      const col = document.createElement("div");
      col.className = "ct-stack-col";
      if (!stack.values.length) {
        col.innerHTML = `<span class="ct-empty">empty stack</span>`;
      } else {
        [...stack.values].reverse().forEach((v, i) => {
          const item = document.createElement("div");
          item.className = `ct-stack-item${i === 0 ? " ct-stack-top" : ""}`;
          item.innerHTML = `<span class="ct-val">${escapeHtml(formatValue(v))}</span>${i === 0 ? `<span class="ct-badge">top</span>` : ""}`;
          col.append(item);
        });
      }
      card.append(col);
      content.append(card);
    });

    // Queues
    containers.queues.forEach((queue) => {
      const card = createContainerDetails(queue.name, "queue", "queue", frame.active);
      const row = document.createElement("div");
      row.className = "ct-queue-row";
      if (!queue.values.length) {
        row.innerHTML = `<span class="ct-empty">empty queue</span>`;
      } else {
        queue.values.forEach((v, i) => {
          const item = document.createElement("div");
          const isFirst = i === 0, isLast = i === queue.values.length - 1;
          item.className = `ct-queue-item${isFirst ? " ct-queue-front" : ""}${isLast ? " ct-queue-rear" : ""}`;
          item.innerHTML = `${isFirst ? `<span class="ct-badge">front</span>` : ""}
            <span class="ct-val">${escapeHtml(formatValue(v))}</span>
            ${isLast && !isFirst ? `<span class="ct-badge">rear</span>` : ""}`;
          row.append(item);
          if (i < queue.values.length - 1) {
            const arr = document.createElement("span");
            arr.className = "ct-queue-arrow";
            arr.textContent = "→";
            row.append(arr);
          }
        });
      }
      card.append(row);
      content.append(card);
    });

    // Priority Queues
    containers.priorityQueues.forEach((pq) => {
      const card = createContainerDetails(pq.name, "priority_queue", "pqueue", frame.active);
      const col = document.createElement("div");
      col.className = "ct-stack-col";
      if (!pq.values.length) {
        col.innerHTML = `<span class="ct-empty">empty priority_queue</span>`;
      } else {
        pq.values.forEach((v, i) => {
          const item = document.createElement("div");
          item.className = `ct-stack-item${i === 0 ? " ct-pq-top" : ""}`;
          item.innerHTML = `<span class="ct-val">${escapeHtml(formatValue(v))}</span>${i === 0 ? `<span class="ct-badge">max</span>` : ""}`;
          col.append(item);
        });
      }
      card.append(col);
      content.append(card);
    });

    // Lists
    containers.lists.forEach((list) => {
      const card = createContainerDetails(list.name, "list", "list", frame.active);
      const row = document.createElement("div");
      row.className = "ct-list-row";
      if (!list.values.length) {
        row.innerHTML = `<span class="ct-empty">empty list</span>`;
      } else {
        list.values.forEach((v, i) => {
          const node = document.createElement("div");
          node.className = "ct-list-node";
          node.textContent = formatValue(v);
          row.append(node);
          if (i < list.values.length - 1) {
            const arr = document.createElement("span");
            arr.className = "ct-list-arrow";
            arr.textContent = "⇄";
            row.append(arr);
          }
        });
      }
      card.append(row);
      content.append(card);
    });

    // Graphs
    containers.graphs.forEach((graph) => {
      const card = createContainerDetails(graph.name, "graph", "graph", frame.active);
      const wrap = document.createElement("div");
      wrap.className = "ct-graph-visual-wrap";
      const svgMarkup = buildAdjacencySvg(graph.edges || [], graph.name);
      if (svgMarkup) {
        const svgHost = document.createElement("div");
        svgHost.className = "ct-graph-svg-host";
        svgHost.innerHTML = svgMarkup;
        wrap.append(svgHost);
      }
      const grid = document.createElement("div");
      grid.className = "ct-graph-grid";
      (graph.edges || []).forEach(([node, neighbors]) => {
        const row = document.createElement("div");
        row.className = "ct-graph-row";
        const nbHtml = Array.isArray(neighbors) && neighbors.length
          ? neighbors.map((n) => `<span class="ct-graph-nb">${escapeHtml(formatValue(n))}</span>`).join("")
          : `<span class="ct-empty">no edges</span>`;
        row.innerHTML = `<div class="ct-graph-node">${escapeHtml(formatValue(node))}</div>
          <div class="ct-graph-edges">${nbHtml}</div>`;
        grid.append(row);
      });
      wrap.append(grid);
      card.append(wrap);
      content.append(card);
    });

    // Unknowns
    containers.unknowns.forEach((unknown) => {
      const fullKind = unknown.kind || "unknown";
      const card = createContainerDetails(unknown.name, shortType(fullKind), "unknown", frame.active);
      const typeChip = card.querySelector(".container-type");
      if (typeChip && fullKind.length > String(typeChip.textContent).length) {
        typeChip.setAttribute("title", fullKind);
      }
      const wrap = document.createElement("div");
      wrap.className = "ct-unknown-wrap";
      if (unknown.preview) {
        const hint = document.createElement("div");
        hint.className = "ct-unknown-hint";
        hint.textContent = unknown.preview;
        wrap.append(hint);
      }
      const schema = document.createElement("div");
      schema.className = "ct-default-struct";
      schema.innerHTML = `
        <div class="ct-default-struct-title">Container details</div>
        <div class="ct-default-struct-rows">
          ${buildUnknownMetadataRows(unknown)}
        </div>`;
      wrap.append(schema);
      if (!unknown.values || !unknown.values.length) {
        const empty = document.createElement("span");
        empty.className = "ct-empty";
        empty.textContent = "No indexed elements parsed — see Locals for scalar fields.";
        wrap.append(empty);
      } else {
        unknown.values.forEach((v, i) => {
          const cell = document.createElement("div");
          cell.className = "ct-unknown-cell";
          cell.innerHTML = `<div class="ct-idx">[${i}]</div><div class="ct-val">${escapeHtml(formatValue(v))}</div>`;
          wrap.append(cell);
        });
      }
      card.append(wrap);
      content.append(card);
    });

    frameDetails.append(content);
    dom.containersView.append(frameDetails);
  });

  if (!hasAny) {
    dom.containersView.innerHTML = `<div class="empty-state">Container-aware visuals show when vector, matrix (nested vectors), array, deque, map, unordered_map, set, unordered_set, stack, queue, priority_queue, list, string, or graph data is available.</div>`;
  }
}

function toggleVariable(frameId, name) {
  const key = getVariableKey(frameId, name);
  if (state.hiddenVariables.has(key)) {
    state.hiddenVariables.delete(key);
  } else {
    state.hiddenVariables.add(key);
  }
  render();
}

function toggleFrame(frameId) {
  if (state.hiddenFrames.has(frameId)) {
    state.hiddenFrames.delete(frameId);
  } else {
    state.hiddenFrames.add(frameId);
  }
  render();
}

function getVariableKey(frameId, variableName) {
  return `${frameId}:${variableName}`;
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return `[${value.join(", ")}]`;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function countContainers(containers) {
  const normalized = normalizeContainers(containers);
  return normalized.arrays.length
    + normalized.maps.length
    + normalized.sets.length
    + normalized.stacks.length
    + normalized.queues.length
    + normalized.priorityQueues.length
    + normalized.lists.length
    + normalized.graphs.length
    + normalized.unknowns.length;
}

function isCurrentFrameContainer(step, name) {
  const active = normalizeContainers(step?.activeContainers);
  return [
    ...active.arrays,
    ...active.maps,
    ...active.sets,
    ...active.stacks,
    ...active.queues,
    ...active.priorityQueues,
    ...active.lists,
    ...active.graphs,
    ...active.unknowns
  ].some((item) => item.name === name);
}

function getContainerContextLabel(step) {
  const total = countContainers(step?.containers);
  const active = countContainers(step?.activeContainers);

  if (!total) {
    return "Vector, matrix, map, set, stack, graph, list renderers";
  }

  if (active === total) {
    return "All visible collections are in the active frame";
  }

  if (active === 0) {
    return "Collections carried from parent frames remain visible";
  }

  return `${active} active-frame, ${total - active} parent-frame collections`;
}

function normalizeContainers(containers) {
  return {
    arrays: containers?.arrays || [],
    maps: containers?.maps || [],
    sets: containers?.sets || [],
    stacks: containers?.stacks || [],
    queues: containers?.queues || [],
    priorityQueues: containers?.priorityQueues || [],
    lists: containers?.lists || [],
    graphs: containers?.graphs || [],
    unknowns: containers?.unknowns || []
  };
}