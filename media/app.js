/* ── VS Code Extension Bridge ─────────────────────────── */
const vscode = (typeof acquireVsCodeApi !== 'undefined') ? acquireVsCodeApi() : null;

if (vscode) {
  window.addEventListener('message', handleExtensionMessage);
}

function handleExtensionMessage(event) {
  const message = event.data;
  
  switch (message.type) {
    case 'stepUpdate':
      updateDebuggerView(message.step, message.stepIndex, message.totalSteps);
      break;
      
    case 'statusUpdate':
      updateStatus(message.status, message.message);
      break;
      
    case 'traceResult':
      // Fallback for full trace
      handleTraceSuccess(message.trace);
      break;
  }
}

function updateStatus(status, message) {
  const statusEl = document.getElementById('debug-status');
  const lineInfo = document.getElementById('line-info');
  
  if (statusEl) statusEl.textContent = message || status;
  if (lineInfo) lineInfo.textContent = status === 'Connected' ? 'Live tracking' : 'No active session';
  
  // Update banner color
  const banner = document.getElementById('debugger-banner');
  if (banner) {
    if (status === 'Connected') {
      banner.style.borderColor = 'var(--accent)';
    } else {
      banner.style.borderColor = 'rgba(255,255,255,0.08)';
    }
  }
}

function updateDebuggerView(step, stepIndex, totalSteps) {
  // Show elements
  document.getElementById('step-info-bar').style.display = 'flex';
  document.getElementById('progress-card').style.display = 'block';
  
  // Update step info
  document.getElementById('step-count').textContent = `Step ${stepIndex + 1}`;
  document.getElementById('event-name').textContent = step.event || '-';
  document.getElementById('line-num').textContent = `Line ${step.line}`;
  
  // Update slider
  const slider = document.getElementById('step-slider');
  slider.max = totalSteps - 1;
  slider.value = stepIndex;
  slider.oninput = (e) => {
    const idx = parseInt(e.target.value);
    vscode.postMessage({ type: 'navigateToStep', stepIndex: idx });
  };
  
  // Update indicators
  document.getElementById('step-indicator').textContent = `${stepIndex + 1} / ${totalSteps}`;
  document.getElementById('event-indicator').textContent = step.event || '-';
  document.getElementById('step-summary').textContent = step.summary || '';
  document.getElementById('line-indicator').textContent = `L${step.line}`;
  
  // Render components
  renderStack(step);
  renderFlow(step);
  renderContainers(step);
  renderMemory(step);
  
  // Update status
  updateStatus('Connected', 'Tracking execution...');
}

/* ── DOM References ──────────────────────────────────── */
const dom = {
  traceTitle: document.querySelector("#trace-title"),
  stepIndicator: document.querySelector("#step-indicator"),
  lineIndicator: document.querySelector("#line-indicator"),
  eventIndicator: document.querySelector("#event-indicator"),
  stepSlider: document.querySelector("#step-slider"),
  stepSummary: document.querySelector("#step-summary"),
  stackView: document.querySelector("#stack-view"),
  flowView: document.querySelector("#flow-view"),
  containersView: document.querySelector("#containers-view"),
  memoryView: document.querySelector("#memory-view"),
  programOutput: document.querySelector("#program-output"),
  outputBadge: document.querySelector("#output-badge"),
  filterUnchanged: document.querySelector("#filter-unchanged"),
  focusMode: document.querySelector("#focus-mode")
};

const state = {
  hiddenVariables: new Set(),
  hiddenFrames: new Set(),
  memoryFrozen: false,
  memoryStepIndex: 0,
  showFlowGraph: true,
  showFlowList: true
};

// Initialize
if (vscode) {
  vscode.postMessage({ type: 'webviewReady' });
}

/* ── Render Functions (same as before, use step directly) ── */

function renderStack(step) {
  dom.stackView.innerHTML = "";
  if (!step?.stack?.length) {
    dom.stackView.innerHTML = `<div class="empty-state">Start debugging to inspect stack frames.</div>`;
    return;
  }

  step.stack.forEach((frame, index) => {
    const frameCard = document.createElement("div");
    frameCard.className = `stack-frame ${frame.active ? "active" : ""}`;
    const args = frame.args?.length ? frame.args.join(", ") : "no arguments";
    const variables = frame.locals || [];

    const visibleVariables = variables.filter((variable) => {
      const key = `${frame.id}:${variable.name}`;
      if (state.hiddenVariables.has(key)) return false;
      return !dom.filterUnchanged.checked || variable.changed;
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
        <span class="frame-meta frame-status">${frame.status}</span>
      </div>
    `;

    if (!variables.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No locals visible";
      frameCard.append(empty);
      dom.stackView.append(frameCard);
      return;
    }

    const variableGrid = document.createElement("div");
    variableGrid.className = "variables-grid";

    if (visibleVariables.length === 0) {
      variableGrid.innerHTML = `<div class="empty-state">No changed variables</div>`;
    } else {
      visibleVariables.forEach((variable) => {
        const row = document.createElement("div");
        row.className = "variable-row";
        const chip = document.createElement("div");
        chip.className = `variable-chip ${variable.changed ? "changed" : ""}`;
        
        let valueHtml = `<div class="variable-value">${formatValue(variable.value)}</div>`;
        if (variable.children && variable.children.length > 0) {
          valueHtml += `<div style="margin-top:4px;padding-left:8px;border-left:2px solid rgba(124,184,255,0.3);">`;
          for (const child of variable.children.slice(0, 5)) {
            valueHtml += `<div style="font-size:0.75rem;color:var(--muted);">${child.name}: ${formatValue(child.value)}</div>`;
          }
          if (variable.children.length > 5) {
            valueHtml += `<div style="font-size:0.75rem;color:var(--muted);">... and ${variable.children.length - 5} more</div>`;
          }
          valueHtml += `</div>`;
        }
        
        chip.innerHTML = `
          <div class="variable-name">${variable.name} <span style="color:var(--muted);font-size:0.7rem;">${variable.type || ''}</span></div>
          ${valueHtml}
        `;
        row.append(chip);
        variableGrid.append(row);
      });
    }

    frameCard.append(variableGrid);
    dom.stackView.append(frameCard);
  });
}

/* ── Keep other render functions same: renderFlow, renderMemory, renderContainers ── */
/* ── Utility functions same: formatValue, escapeHtml, etc. ── */

function formatValue(value) {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "string") return value.length > 100 ? value.slice(0, 100) + '...' : value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value).slice(0, 200);
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