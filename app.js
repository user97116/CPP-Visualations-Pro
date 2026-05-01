const dom = {
  runVisualizer: document.querySelector("#run-visualizer"),
  codeEditor: document.querySelector("#code-editor"),
  filterUnchanged: document.querySelector("#filter-unchanged"),
  focusMode: document.querySelector("#focus-mode"),
  traceTitle: document.querySelector("#trace-title"),
  stepIndicator: document.querySelector("#step-indicator"),
  lineIndicator: document.querySelector("#line-indicator"),
  eventIndicator: document.querySelector("#event-indicator"),
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
  playPause: document.querySelector("#play-pause")
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
  } catch (error) {
    state.trace = null;
    dom.traceTitle.textContent = "Trace failed";
    dom.eventIndicator.textContent = "Backend or compile error";
    dom.stepSummary.textContent = error.message || "The trace could not be generated.";
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

  renderCode(trace, step);
  renderStack(step);
  renderFlow(step);
  const memoryStep = trace && state.memoryFrozen ? trace.steps[state.memoryStepIndex] : step;
  renderMemory(memoryStep);
  renderContainers(step);
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
          : `
            <div class="variable-name">${variable.name}</div>
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
  if (!nodes.length) {
    dom.flowView.innerHTML = `<div class="empty-state">Recursion and nested call flow will appear here when detected.</div>`;
    return;
  }

  const edges = step?.tree?.edges || [];
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

  const leafXStep = 130;
  const levelHeight = 110;
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
      const x = 80 + leafCursor * leafXStep;
      leafCursor += 1;
      positions.set(nodeId, { x, y: 50 + depth * levelHeight, depth });
      return { x, maxDepth: depth };
    }

    const childLayouts = children.map((childId) => assignNode(childId, depth + 1));
    const minX = Math.min(...childLayouts.map((item) => item.x));
    const maxX = Math.max(...childLayouts.map((item) => item.x));
    const x = Math.round((minX + maxX) / 2);
    const maxDepth = Math.max(depth, ...childLayouts.map((item) => item.maxDepth));
    positions.set(nodeId, { x, y: 50 + depth * levelHeight, depth });
    return { x, maxDepth };
  }

  let treeMaxDepth = 0;
  roots.forEach((rootId) => {
    const { maxDepth } = assignNode(rootId, 0);
    treeMaxDepth = Math.max(treeMaxDepth, maxDepth);
  });
  nodes.forEach((node) => {
    if (!positions.has(node.id)) {
      assignNode(node.id, 0);
    }
  });

  const width = Math.max(720, 120 + leafCursor * leafXStep);
  const height = Math.max(170, (treeMaxDepth + 1) * levelHeight + 40);

  const edgeSvg = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) {
      return "";
    }
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`;
  }).join("");

  const nodeSvg = nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position) {
      return "";
    }
    const className = node.active ? "flow-node active" : `flow-node ${node.done ? "done" : ""}`;
    const functionName = escapeHtml(node.function || node.label);
    const paramText = Array.isArray(node.params) && node.params.length
      ? escapeHtml(node.params.join(", "))
      : "no params";
    const compactParam = paramText.length > 22 ? `${paramText.slice(0, 21)}...` : paramText;
    return `
      <g class="${className}">
        <rect x="${position.x - 72}" y="${position.y - 24}" rx="10" ry="10" width="144" height="48" />
        <text x="${position.x}" y="${position.y - 4}" text-anchor="middle">${functionName}</text>
        <text x="${position.x}" y="${position.y + 11}" text-anchor="middle">(${compactParam})</text>
        <title>${escapeHtml(`${node.label} | ${node.meta}`)}</title>
      </g>
    `;
  }).join("");

  const graphBlock = state.showFlowGraph
    ? `
    <svg class="flow-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recursion tree">
      <g class="flow-lines">${edgeSvg}</g>
      <g class="flow-nodes">${nodeSvg}</g>
    </svg>`
    : `<div class="empty-state">Graph section hidden. Use "Show graph" to view recursion tree.</div>`;

  const listBlock = state.showFlowList
    ? `
    <div class="flow-list">
      ${nodes.map((node) => `
        <div class="node ${node.active ? "active" : ""} ${node.done ? "done" : ""}">
          <div class="node-label">${escapeHtml(node.function || node.label)}</div>
          <div class="node-meta">${escapeHtml((node.params || []).length ? (node.params || []).join(", ") : "no params")}</div>
          <div class="node-meta">${escapeHtml(node.meta)}</div>
        </div>
      `).join("")}
    </div>`
    : `<div class="empty-state">Details section hidden. Use "Show details" to expand node list.</div>`;

  dom.flowView.innerHTML = `${graphBlock}${listBlock}`;
}

function renderMemory(step) {
  dom.memoryView.innerHTML = "";

  if (!step) {
    dom.memoryView.innerHTML = `<div class="empty-state">Run a trace to map pointer addresses as connected nodes.</div>`;
    return;
  }

  const graph = step.memory || { nodes: [], edges: [] };
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];

  if (!edges.length) {
    dom.memoryView.innerHTML = `<div class="empty-state">No pointer-like addresses found at this step. Try linked list or tree node pointers.</div>`;
    return;
  }

  const nodeOrder = nodes.length
    ? nodes.map((node) => node.id)
    : [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  const nodeMetaById = new Map(nodes.map((node) => [node.id, node]));
  const nodeIndex = new Map(nodeOrder.map((nodeId, index) => [nodeId, index]));
  const width = 360;
  const height = Math.max(180, nodeOrder.length * 40);
  const radius = 14;
  const xForIndex = (index) => (index % 2 === 0 ? 90 : width - 90);
  const yForIndex = (index) => 34 + index * 32;
  const lineSvg = edges.map((edge) => {
    const sourceIndex = nodeIndex.get(edge.from);
    const targetIndex = nodeIndex.get(edge.to);
    if (sourceIndex === undefined || targetIndex === undefined) {
      return "";
    }
    const middleX = (xForIndex(sourceIndex) + xForIndex(targetIndex)) / 2;
    const middleY = (yForIndex(sourceIndex) + yForIndex(targetIndex)) / 2;
    return `
      <line x1="${xForIndex(sourceIndex)}" y1="${yForIndex(sourceIndex)}" x2="${xForIndex(targetIndex)}" y2="${yForIndex(targetIndex)}" />
      <text class="edge-label" x="${middleX}" y="${middleY - 6}" text-anchor="middle">${edge.label || "ptr"}</text>
    `;
  }).join("");

  dom.memoryView.innerHTML = `
    <div class="memory-meta">${edges.length} links | ${nodeOrder.length} nodes</div>
    <svg class="memory-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Address graph">
      <g class="memory-lines">${lineSvg}</g>
      ${nodeOrder.map((nodeId, index) => {
        const x = xForIndex(index);
        const y = yForIndex(index);
        const meta = nodeMetaById.get(nodeId);
        const label = meta?.label || nodeId;
        const kind = meta?.kind || (nodeId.startsWith("0x") ? "address" : "variable");
        const className = kind === "address" ? "memory-node address-node" : "memory-node variable-node";
        return `
          <g class="${className}">
            <circle cx="${x}" cy="${y}" r="${radius}" />
            <text x="${x}" y="${y + 4}" text-anchor="middle">${index + 1}</text>
            <title>${escapeHtml(label)}</title>
          </g>
        `;
      }).join("")}
    </svg>
    <div class="memory-legend">
      ${nodeOrder.map((nodeId, index) => `
        <div class="memory-legend-row">
          <span class="memory-badge">${index + 1}</span>
          <span class="memory-label">${escapeHtml(nodeMetaById.get(nodeId)?.label || nodeId)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderContainers(step) {
  dom.containersView.innerHTML = "";

  const containers = normalizeContainers(step?.containers);
  if (
    !containers.arrays.length
      && !containers.maps.length
      && !containers.sets.length
      && !containers.stacks.length
      && !containers.queues.length
      && !containers.priorityQueues.length
      && !containers.lists.length
      && !containers.graphs.length
  ) {
    dom.containersView.innerHTML = `<div class="empty-state">Container-aware visuals show only when vector, deque, map, unordered_map, set, unordered_set, stack, queue, priority_queue, list, or graph data is available.</div>`;
    return;
  }

  containers.arrays.forEach((array) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, array.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${array.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, array.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const grid = document.createElement("div");
    grid.className = "array-grid";

    array.values.forEach((value, index) => {
      const cell = document.createElement("div");
      cell.className = "array-cell";
      cell.innerHTML = `
        <div class="array-index">[${index}]</div>
        <div class="array-value">${formatValue(value)}</div>
      `;
      grid.append(cell);
    });

    card.append(grid);
    dom.containersView.append(card);
  });

  containers.maps.forEach((map) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, map.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${map.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, map.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    map.entries.forEach(([key, value]) => {
      const row = document.createElement("div");
      row.className = "map-row";
      row.innerHTML = `<span>${key}</span><span>${formatValue(value)}</span>`;
      card.append(row);
    });

    dom.containersView.append(card);
  });

  containers.sets.forEach((set) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, set.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${set.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, set.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const row = document.createElement("div");
    row.className = "set-row";
    set.values.forEach((value) => {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = formatValue(value);
      row.append(pill);
    });
    card.append(row);
    dom.containersView.append(card);
  });

  containers.stacks.forEach((stack) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, stack.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${stack.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, stack.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const row = document.createElement("div");
    row.className = "set-row";
    [...stack.values].reverse().forEach((value, index) => {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = index === 0 ? `top: ${formatValue(value)}` : formatValue(value);
      row.append(pill);
    });

    if (stack.values.length === 0) {
      row.innerHTML = `<span class="hidden-variable">empty stack</span>`;
    }

    card.append(row);
    dom.containersView.append(card);
  });

  containers.queues.forEach((queue) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, queue.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${queue.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, queue.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const row = document.createElement("div");
    row.className = "set-row";
    if (!queue.values.length) {
      row.innerHTML = `<span class="hidden-variable">empty queue</span>`;
    } else {
      queue.values.forEach((value, index) => {
        const pill = document.createElement("span");
        pill.className = "pill";
        if (index === 0) {
          pill.textContent = `front: ${formatValue(value)}`;
        } else if (index === queue.values.length - 1) {
          pill.textContent = `rear: ${formatValue(value)}`;
        } else {
          pill.textContent = formatValue(value);
        }
        row.append(pill);
      });
    }

    card.append(row);
    dom.containersView.append(card);
  });

  containers.priorityQueues.forEach((queue) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, queue.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${queue.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, queue.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const row = document.createElement("div");
    row.className = "set-row";
    if (!queue.values.length) {
      row.innerHTML = `<span class="hidden-variable">empty priority_queue</span>`;
    } else {
      queue.values.forEach((value, index) => {
        const pill = document.createElement("span");
        pill.className = "pill";
        pill.textContent = index === 0 ? `top: ${formatValue(value)}` : formatValue(value);
        row.append(pill);
      });
    }

    card.append(row);
    dom.containersView.append(card);
  });

  containers.lists.forEach((list) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, list.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${list.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, list.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const row = document.createElement("div");
    row.className = "linked-list";
    if (!list.values.length) {
      row.innerHTML = `<span class="hidden-variable">empty list</span>`;
    } else {
      list.values.forEach((value, index) => {
        const node = document.createElement("span");
        node.className = "list-node";
        node.textContent = formatValue(value);
        row.append(node);
        if (index < list.values.length - 1) {
          const arrow = document.createElement("span");
          arrow.className = "list-arrow";
          arrow.textContent = "->";
          row.append(arrow);
        }
      });
    }
    card.append(row);
    dom.containersView.append(card);
  });

  containers.graphs.forEach((graph) => {
    const card = document.createElement("div");
    card.className = `container-card ${isCurrentFrameContainer(step, graph.name) ? "current-frame" : ""}`;
    card.innerHTML = `
      <div class="container-title">
        <strong>${graph.name}</strong>
        <span class="container-origin">${isCurrentFrameContainer(step, graph.name) ? "active frame" : "parent frame"}</span>
      </div>
    `;

    const grid = document.createElement("div");
    grid.className = "graph-grid";
    graph.edges.forEach(([node, neighbors]) => {
      const row = document.createElement("div");
      row.className = "graph-row";
      const edgeHtml = neighbors.length
        ? neighbors.map((item) => `<span class="edge-pill">${formatValue(item)}</span>`).join("")
        : `<span class="hidden-variable">no edges</span>`;
      row.innerHTML = `
        <div class="graph-node">${formatValue(node)}</div>
        <div class="graph-edges">${edgeHtml}</div>
      `;
      grid.append(row);
    });
    card.append(grid);
    dom.containersView.append(card);
  });
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
    + normalized.graphs.length;
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
    ...active.graphs
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
    graphs: containers?.graphs || []
  };
}
