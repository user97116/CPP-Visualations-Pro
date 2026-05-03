const vscode = acquireVsCodeApi();

const dom = {
  // Removed runVisualizer and codeEditor
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
  // Removed codeEditor placeholder and event listener
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

  window.addEventListener('message', event => {
    const message = event.data; // The JSON data our extension sent
    switch (message.command) {
      case 'updateTrace':
        updateTrace(message.trace);
        break;
      case 'updateStep':
        updateStep(message.stepIndex);
        break;
    }
  });

  render();
}

function updateTrace(newTrace) {
  state.trace = newTrace;
  state.isLoading = false;
  state.stepIndex = 0;
  dom.stepSlider.max = Math.max((state.trace?.steps.length || 1) - 1, 0);
  dom.stepSlider.value = "0";
  // dom.runVisualizer.disabled = false; // Removed
  // dom.runVisualizer.textContent = "Run visualization"; // Removed

  const out = (newTrace.stdout ?? "").trim();
  if (out) {
    dom.programOutput.textContent = out;
    dom.programOutput.className = "output-pre";
    dom.outputBadge.textContent = `${out.split("\n").length} line${out.split("\n").length !== 1 ? "s" : ""}`;
  } else {
    dom.programOutput.textContent = "No output produced.";
    dom.programOutput.className = "output-pre empty";
    dom.outputBadge.textContent = "stdout";
  }
  render();
}

function updateStep(newStepIndex) {
  stopPlayback();
  state.stepIndex = clamp(newStepIndex, 0, (state.trace?.steps.length || 1) - 1);
  dom.stepSlider.value = String(state.stepIndex);
  render();
}

// Removed runVisualization function

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
  dom.stepSummary.textContent = step ? step.summary : dom.stepSummary.textContent || "Run the VS Code debugger to inspect real execution flow.";
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

  const lines = trace ? trace.code.split("\n") : ["// No code loaded. Start debugging to see the trace."];
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
        chip.innerHTML = hidden
          ? `<div class="hidden-variable">${variable.name} hidden</div>`
          :
            `<div class="variable-name">${variable.name}</div>
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
      return {
        x: old?.x || 50,
        maxDepth: depth
      };
    }
    visited.add(nodeId);
    const children = childrenMap.get(nodeId) || [];
    if (children.length === 0) {
      const x = NODE_W / 2 + PAD + leafCursor * leafXStep;
      leafCursor += 1;
      positions.set(nodeId, {
        x,
        y: NODE_H / 2 + PAD + depth * levelHeight
      });
      return {
        x,
        maxDepth: depth
      };
    }

    const childLayouts = children.map((childId) => assignNode(childId, depth + 1));
    const minX = Math.min(...childLayouts.map((item) => item.x));
    const maxX = Math.max(...childLayouts.map((item) => item.x));
    const x = Math.round((minX + maxX) / 2);
    const maxDepth = Math.max(depth, ...childLayouts.map((item) => item.maxDepth));
    positions.set(nodeId, {
      x,
      y: NODE_H / 2 + PAD + depth * levelHeight
    });
    return {
      x,
      maxDepth
    };
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
    const x2 = to.x, y2 = to.y - NODE_H / 2;
    const cy = (y1 + y2) / 2;
    return `<path d="M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}" />`;
  }).join("");

  const nodeSvg = nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return "";
    const cls = node.active ? "flow-node active" : `flow-node${node.done ? " done" : ""}`;
    const fnName = escapeHtml(node.function || node.label);
    const paramText = Array.isArray(node.params) && node.params.length ?
      node.params.join(", ") : "";
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

  const graphBlock = state.showFlowGraph ?
    `<div class="flow-svg-scroll">
        <svg class="flow-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Recursion tree">
          <g class="flow-lines">${edgeSvg}</g>
          <g class="flow-nodes">${nodeSvg}</g>
        </svg>
      </div>` :
    `<div class="empty-state">Graph section hidden. Use "Show graph" to view recursion tree.</div>`;

  const listBlock = state.showFlowList ?
    `
    <div class="flow-list">
      ${nodes.map((node) => `
        <div class="node ${node.active ? "active" : ""} ${node.done ? "done" : ""}">
          <div class="node-label">${escapeHtml(node.function || node.label)}</div>
          <div class="node-meta">${escapeHtml((node.params || []).length ? (node.params || []).join(", ") : "no params")}</div>
          <div class="node-meta">${escapeHtml(node.meta)}</div>
        </div>
      `).join("")}
    </div>` :
    `<div class="empty-state">Details section hidden. Use "Show details" to expand node list.</div>`;

  dom.flowView.innerHTML = `${graphBlock}${listBlock}`;
}

function renderMemory(step) {
  dom.memoryView.innerHTML = "";

  if (!step) {
    dom.memoryView.innerHTML = `<div class="empty-state">Run a trace to map pointer addresses as connected nodes.</div>`;
    return;
  }

  const graph = step.memory || {
    nodes: [],
    edges: []
  };
  const edges = graph.edges || [];
  const nodes = graph.nodes || [];

  if (!edges.length || !nodes.length) {
    dom.memoryView.innerHTML = `<div class="empty-state">No pointer-like addresses found at this step. Try linked list or tree node pointers.</div>`;
    return;
  }

  const CW = 160,
    CH = 56,
    HGAP = 24,
    VGAP = 72,
    PAD = 20;

  const varNodes = nodes.filter(n => n.kind === "variable");
  const addrNodes = nodes.filter(n => n.kind !== "variable");

  const varX = new Map(varNodes.map((n, i) => [n.id, PAD + i * (CW + HGAP) + CW / 2]));
  const addrX = new Map(addrNodes.map((n, i) => [n.id, PAD + i * (CW + HGAP) + CW / 2]));

  const varY = PAD + CH / 2;
  const addrY = PAD + CH + VGAP + CH / 2;

  const xFor = (id) => varX.get(id) ?? addrX.get(id) ?? PAD + CW / 2;
  const yFor = (id) => varX.has(id) ? varY : addrY;

  const totalCols = Math.max(varNodes.length, addrNodes.length);
  const svgW = PAD * 2 + totalCols * (CW + HGAP) - HGAP;
  const svgH = addrNodes.length ? addrY + CH / 2 + PAD : varY + CH / 2 + PAD;

  const edgeSvg = edges.map(edge => {
    const x1 = xFor(edge.from), y1 = yFor(edge.from) + CH / 2;
    const x2 = xFor(edge.to), y2 = yFor(edge.to) - CH / 2;
    if (!x1 || !x2) return "";
    const rawLabel = edge.label || "";
    const label = rawLabel.startsWith("0x") && rawLabel.length > 10 ?
      rawLabel.slice(0, 6) + "…" + rawLabel.slice(-4) : rawLabel;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)" />
            ${label ? `<text class="edge-label" x="${mx + 6}" y="${my}" text-anchor="start">${escapeHtml(label)}</text>` : ""}`;
  }).join("");

  const renderNode = (n, x, y) => {
    const isAddr = n.kind !== "variable";
    const cls = isAddr ? "memory-node address-node" : "memory-node variable-node";
    const label = escapeHtml(n.label || n.id);
    let sub = "";
    if (!isAddr) {
      const edge = edges.find(e => e.from === n.id);
      if (edge) {
        const addr = edge.to;
        sub = addr.length > 12 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr;
      }
    } else {
      sub = n.id.length > 12 ? n.id.slice(0, 6) + "…" + n.id.slice(-4) : n.id;
    }
    return `<g class="${cls}">
      <rect x="${x - CW/2}" y="${y - CH/2}" width="${CW}" height="${CH}" rx="10" />
      <text x="${x}" y="${y - 7}" text-anchor="middle" class="mem-name">${label}</text>
      <text x="${x}" y="${y + 10}" text-anchor="middle" class="mem-val">${escapeHtml(sub)}</text>
    </g>`;
  };

  const nodesSvg = [
    ...varNodes.map(n => renderNode(n, varX.get(n.id), varY)),
    ...addrNodes.map(n => renderNode(n, addrX.get(n.id), addrY))
  ].join("");

  dom.memoryView.innerHTML = `
    <div class="memory-meta">${edges.length} pointer${edges.length !== 1 ? "s" : ""} | ${varNodes.length} variable${varNodes.length !== 1 ? "s" : ""}</div>
    <div class="memory-svg-scroll">
      <svg class="memory-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" role="img" aria-label="Address graph">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="rgba(124,184,255,0.7)" />
          </marker>
        </defs>
        <g class="memory-lines">${edgeSvg}</g>
        <g>${nodesSvg}</g>
      </svg>
    </div>`;
}

function createContainerCard(name, type, typeClass, isActive) {
  const card = document.createElement("div");
  card.className = `container-card ct-${typeClass}${isActive ? " current-frame" : ""}`;
  card.innerHTML = `<div class="container-title">
    <strong>${escapeHtml(name)}</strong>
    <span class="container-type">${type}</span>
    <span class="container-origin">${isActive ? "active frame" : "parent frame"}</span>
  </div>`;
  return card;
}

function renderContainers(step) {
  dom.containersView.innerHTML = "";

  if (!step?.stack?.length) {
    dom.containersView.innerHTML = `<div class="empty-state">Container-aware visuals show only when vector, deque, map, unordered_map, set, unordered_set, stack, queue, priority_queue, list, or graph data is available.</div>`;
    return;
  }

  let hasAny = false;

  step.stack.forEach((frame, frameIdx) => {
    const containers = normalizeContainers(frame.containers);
    if (countContainers(containers) === 0) return;
    hasAny = true;

    const section = document.createElement("div");
    section.className = "frame-containers-section";

    const header = document.createElement("div");
    header.className = `frame-containers-header ${frame.active ? "active-frame-header" : ""}`;
    header.innerHTML = `
      <span class="frame-index">${frameIdx + 1}</span>
      <strong>${escapeHtml(frame.name)}</strong>
      <span class="frame-origin">${frame.active ? "active frame" : "parent frame"}</span>
    `;
    section.append(header);

    const content = document.createElement("div");
    content.className = "frame-containers-content";

    // Arrays: vector, deque, string
    containers.arrays.forEach((array) => {
      const typeClass = array.kind || "vector";
      const card = createContainerCard(array.name, typeClass, typeClass, frame.active);
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
      const card = createContainerCard(map.name, map.kind || "map", "map", frame.active);
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
      const card = createContainerCard(set.name, set.kind || "set", "set", frame.active);
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
      const card = createContainerCard(stack.name, "stack", "stack", frame.active);
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
      const card = createContainerCard(queue.name, "queue", "queue", frame.active);
      const row = document.createElement("div");
      row.className = "ct-queue-row";
      if (!queue.values.length) {
        row.innerHTML = `<span class="ct-empty">empty queue</span>`;
      } else {
        queue.values.forEach((v, i) => {
          const item = document.createElement("div");
          const isFirst = i === 0,
            isLast = i === queue.values.length - 1;
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
      const card = createContainerCard(pq.name, "priority_queue", "pqueue", frame.active);
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
      const card = createContainerCard(list.name, "list", "list", frame.active);
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
      const card = createContainerCard(graph.name, "graph", "graph", frame.active);
      const grid = document.createElement("div");
      grid.className = "ct-graph-grid";
      graph.edges.forEach(([node, neighbors]) => {
        const row = document.createElement("div");
        row.className = "ct-graph-row";
        const nbHtml = Array.isArray(neighbors) && neighbors.length ?
          neighbors.map((n) => `<span class="ct-graph-nb">${escapeHtml(formatValue(n))}</span>`).join("") :
          `<span class="ct-empty">no edges</span>`;
        row.innerHTML = `<div class="ct-graph-node">${escapeHtml(formatValue(node))}</div>
          <div class="ct-graph-edges">${nbHtml}</div>`;
        grid.append(row);
      });
      card.append(grid);
      content.append(card);
    });

    // Unknowns
    containers.unknowns.forEach((unknown) => {
      const card = createContainerCard(unknown.name, unknown.kind || "unknown", "unknown", frame.active);
      const wrap = document.createElement("div");
      wrap.className = "ct-unknown-wrap";
      if (!unknown.values || !unknown.values.length) {
        wrap.innerHTML = `<span class="ct-empty">empty or opaque</span>`;
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

    section.append(content);
    dom.containersView.append(section);
  });

  if (!hasAny) {
    dom.containersView.innerHTML = `<div class="empty-state">Container-aware visuals show only when vector, deque, map, unordered_map, set, unordered_set, stack, queue, priority_queue, list, or graph data is available.</div>`;
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
  return normalized.arrays.length +
    normalized.maps.length +
    normalized.sets.length +
    normalized.stacks.length +
    normalized.queues.length +
    normalized.priorityQueues.length +
    normalized.lists.length +
    normalized.graphs.length +
    normalized.unknowns.length;
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
    return "Vector, map, set, stack, graph, list renderers";
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