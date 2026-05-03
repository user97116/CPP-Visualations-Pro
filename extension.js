const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let currentPanel = null;
let debugTracker = null;
let stepHistory = [];
let currentStepIndex = -1;

/* ═══════════════════════════════════════════════════════
   CppFlowPanel — Clean visualization only
   ═══════════════════════════════════════════════════════ */
class CppFlowPanel {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.currentStep = null;
    this._webviewReady = false;
    this._pendingTrace = null;

    this.panel = vscode.window.createWebviewPanel(
      'cppFlow',
      'C++ Flow Studio',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    this.panel.webview.html = this._getHtml();
    this.panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg), undefined, []);
    this.panel.onDidDispose(() => { currentPanel = null; });
  }

  reveal() {
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside);
  }

  updateStep(step, stepIndex, totalSteps) {
    if (!this._webviewReady || !this.panel) return;
    
    this.currentStep = step;
    this.panel.webview.postMessage({
      type: 'stepUpdate',
      step: step,
      stepIndex: stepIndex,
      totalSteps: totalSteps
    });
  }

  updateStatus(status, message) {
    if (!this._webviewReady || !this.panel) return;
    this.panel.webview.postMessage({
      type: 'statusUpdate',
      status: status,
      message: message
    });
  }

  _handleMessage(message) {
    if (message.type === 'webviewReady') {
      this._webviewReady = true;
      // Send current state if available
      if (currentStepIndex >= 0 && stepHistory[currentStepIndex]) {
        this.updateStep(stepHistory[currentStepIndex], currentStepIndex, stepHistory.length);
      }
      return;
    }
    
    // Handle slider/manual navigation from panel
    if (message.type === 'navigateToStep') {
      currentStepIndex = message.stepIndex;
      if (stepHistory[currentStepIndex]) {
        this.updateStep(stepHistory[currentStepIndex], currentStepIndex, stepHistory.length);
      }
    }
  }

  _getHtml() {
    const webview = this.panel.webview;
    const mediaUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media'));
    const styleUri = vscode.Uri.joinPath(mediaUri, 'styles.css');
    const scriptUri = vscode.Uri.joinPath(mediaUri, 'app.js');
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} blob:; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>C++ Flow Studio</title>
  <style>
    /* Override for debugger-connected mode */
    .debugger-mode .editor-panel,
    .debugger-mode .surface-strip { display: none !important; }
    
    .debugger-banner {
      position: sticky;
      top: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 18px;
      border-radius: 10px;
      background: rgba(30, 30, 40, 0.92);
      backdrop-filter: blur(8px);
      border: 1px solid var(--accent);
      font-size: 0.88rem;
      margin-bottom: 16px;
    }
    
    .debugger-banner .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 1.5s infinite;
    }
    
    .debugger-banner .status-text {
      color: var(--accent);
      font-weight: 600;
    }
    
    .debugger-banner .line-info {
      margin-left: auto;
      font-family: var(--font-code);
      color: var(--muted);
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    
    .step-info-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      border-radius: 14px;
      background: rgba(99, 230, 190, 0.08);
      border: 1px solid rgba(99, 230, 190, 0.2);
      margin-bottom: 16px;
    }
    
    .step-info-bar .step-count {
      font-family: var(--font-code);
      color: var(--accent);
      font-weight: 600;
    }
    
    .step-info-bar .event-name {
      color: var(--text);
      font-weight: 600;
    }
    
    .step-info-bar .line-num {
      margin-left: auto;
      color: var(--muted);
      font-family: var(--font-code);
    }
  </style>
</head>
<body class="debugger-mode">
  <div class="app-shell">
    <div class="workspace-layout">
      <div class="trace-column">
        <!-- Debugger Status Banner -->
        <div class="panel">
          <div class="debugger-banner" id="debugger-banner">
            <span class="status-dot"></span>
            <span class="status-text" id="debug-status">Waiting for debugger...</span>
            <span class="line-info" id="line-info">No active session</span>
          </div>
          
          <!-- Step Info -->
          <div class="step-info-bar" id="step-info-bar" style="display:none;">
            <span class="step-count" id="step-count">Step 0</span>
            <span class="event-name" id="event-name">-</span>
            <span class="line-num" id="line-num">Line -</span>
          </div>
          
          <!-- Step Slider -->
          <div class="progress-card" id="progress-card" style="display:none;">
            <div class="panel-header">
              <div>
                <div class="eyebrow">History</div>
                <strong id="step-indicator">0 / 0</strong>
              </div>
            </div>
            <input type="range" id="step-slider" min="0" max="0" value="0">
            <div class="step-summary" id="step-summary">Start debugging to see execution flow.</div>
          </div>
        </div>

        <div class="panel stage-panel" style="min-height:auto;">
          <div class="panel-header trace-header-panel">
            <div>
              <div class="eyebrow" id="trace-title">Real-time Debugger</div>
              <h2 id="event-indicator">Not connected</h2>
            </div>
            <div class="toggles">
              <label class="toggle"><input type="checkbox" id="filter-unchanged"> Hide unchanged</label>
              <label class="toggle"><input type="checkbox" id="focus-mode"> Focus mode</label>
            </div>
          </div>
        </div>
      </div>

      <div class="layout">
        <!-- Surface removed -->

        <div class="insights-grid">
          <div class="subpanel collections-panel">
            <div class="subpanel-title-row">
              <h3>Collections</h3>
              <span id="container-context-label">Vector, map, set, stack, graph, list renderers</span>
            </div>
            <div class="containers-view" id="containers-view"></div>
          </div>

          <div class="subpanel stack-panel">
            <div class="subpanel-title-row">
              <h3>Stack</h3>
              <span>frames</span>
            </div>
            <div class="stack-view" id="stack-view"></div>
          </div>

          <div class="subpanel flow-panel">
            <div class="subpanel-title-row">
              <h3>Flow</h3>
              <div class="flow-controls">
                <button id="toggle-flow-graph" class="ghost-button small">Hide graph</button>
                <button id="toggle-flow-list" class="ghost-button small">Hide details</button>
              </div>
            </div>
            <div class="flow-view" id="flow-view"></div>
          </div>

          <div class="subpanel memory-panel">
            <div class="subpanel-title-row">
              <h3>Memory</h3>
              <button id="visualize-addresses" class="ghost-button small">Visualize</button>
            </div>
            <div class="memory-view" id="memory-view"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Playback controls disabled in debugger mode -->
    <div class="playback-dock" style="opacity:0.5; pointer-events:none;">
      <button id="prev-step" class="icon-button">←</button>
      <button id="play-pause" class="primary-button small">Auto</button>
      <button id="next-step" class="icon-button">→</button>
    </div>

    <div class="output-panel">
      <div class="output-panel-header">
        <h3>Program Output</h3>
        <span class="output-badge" id="output-badge">stdout</span>
      </div>
      <pre class="output-pre empty" id="program-output">Start debugging to see output.</pre>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/* ═══════════════════════════════════════════════════════
   DebugTracker — VS Code Debugger Integration
   ═══════════════════════════════════════════════════════ */
class DebugTracker {
  constructor(panel) {
    this.panel = panel;
    this.isTracking = false;
    this.lastLine = null;
    this.lastFile = null;
    this.stepCounter = 0;
    this.disposables = [];
  }

  start() {
    if (this.isTracking) return;
    this.isTracking = true;
    stepHistory = [];
    currentStepIndex = -1;
    this.stepCounter = 0;

    this.panel.updateStatus('Connected', 'Tracking VS Code debugger...');

    // Track stack changes (when debugger stops at a line)
    this.disposables.push(
      vscode.debug.onDidChangeActiveStackItem(async () => {
        await this._captureState();
      })
    );

    // Track when debugger stops (breakpoint, step complete, etc.)
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session) {
          return {
            onDidSendMessage: async (msg) => {
              if (msg.type === 'event' && msg.event === 'stopped') {
                await this._captureState();
              }
            }
          };
        }
      })
    );

    // Alternative: Poll when session is active
    this._startPolling();
  }

  stop() {
    this.isTracking = false;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.panel.updateStatus('Disconnected', 'Debugger session ended');
  }

  _startPolling() {
    const poll = async () => {
      if (!this.isTracking) return;
      
      const session = vscode.debug.activeDebugSession;
      if (session) {
        // Check if stopped (not running)
        try {
          const threads = await session.customRequest('threads');
          for (const thread of threads.threads || []) {
            if (thread.name !== 'Running') {
              await this._captureState();
              break;
            }
          }
        } catch (e) {
          // Session might be ending
        }
      }
      
      setTimeout(poll, 50); // 50ms poll
    };
    poll();
  }

  async _captureState() {
    const session = vscode.debug.activeDebugSession;
    if (!session) return;

    try {
      // Get all threads, find stopped one
      const threads = await session.customRequest('threads');
      let stoppedThread = null;
      
      for (const thread of threads.threads || []) {
        // Try to get stack trace for this thread
        try {
          const stack = await session.customRequest('stackTrace', { 
            threadId: thread.id,
            startFrame: 0,
            levels: 20
          });
          if (stack && stack.stackFrames && stack.stackFrames.length > 0) {
            stoppedThread = { id: thread.id, frames: stack.stackFrames };
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!stoppedThread) return;

      const frames = stoppedThread.frames;
      const topFrame = frames[0];
      const currentLine = topFrame.line;
      const currentFile = topFrame.source?.path || topFrame.source?.name || 'unknown';
      const functionName = topFrame.name || 'unknown';

      // Skip if same line (duplicate)
      if (this.lastLine === currentLine && this.lastFile === currentFile) {
        return;
      }
      this.lastLine = currentLine;
      this.lastFile = currentFile;

      this.stepCounter++;

      // Build stack data with variables
      const stackData = [];
      for (let i = 0; i < Math.min(frames.length, 10); i++) {
        const frame = frames[i];
        const frameLocals = await this._getFrameVariables(session, frame.id, i);
        
        stackData.push({
          id: `${frame.name}|${i}`,
          name: frame.name,
          line: frame.line,
          file: frame.source?.path || 'unknown',
          active: i === 0,
          status: i === 0 ? 'active' : 'waiting',
          locals: frameLocals,
          args: []
        });
      }

      // Build step
      const step = {
        line: currentLine,
        file: currentFile,
        event: this._describeEvent(functionName, currentLine),
        summary: `${functionName} at line ${currentLine}`,
        stdout: '',
        stack: stackData,
        containers: this._extractContainers(stackData),
        activeContainers: this._extractContainers([stackData[0]]),
        memory: { nodes: [], edges: [] },
        tree: this._buildFlowTree(stackData)
      };

      // Mark changes
      if (currentStepIndex >= 0 && stepHistory[currentStepIndex]) {
        this._markChangedValues(stepHistory[currentStepIndex], step);
      }

      // Add to history
      stepHistory.push(step);
      currentStepIndex = stepHistory.length - 1;

      // Update panel
      this.panel.updateStep(step, currentStepIndex, stepHistory.length);

      // Highlight line in editor (optional - VS Code already does this)
      // But we can add custom decoration if needed

    } catch (err) {
      console.error('[CppFlow] Capture error:', err.message);
    }
  }

  async _getFrameVariables(session, frameId, frameIndex) {
    const locals = [];
    
    try {
      // Get scopes
      const scopes = await session.customRequest('scopes', { frameId });
      
      for (const scope of scopes.scopes || []) {
        if (!scope.expensive) { // Skip expensive scopes
          const vars = await session.customRequest('variables', {
            variablesReference: scope.variablesReference
          });
          
          for (const v of vars.variables || []) {
            // Handle nested variables (objects, arrays)
            let value = v.value;
            let children = [];
            
            if (v.variablesReference > 0) {
              try {
                const childVars = await session.customRequest('variables', {
                  variablesReference: v.variablesReference
                });
                children = childVars.variables.map(cv => ({
                  name: cv.name,
                  value: cv.value,
                  type: cv.type
                }));
              } catch (e) {}
            }
            
            locals.push({
              name: v.name,
              value: value,
              type: v.type || 'unknown',
              changed: false,
              children: children
            });
          }
        }
      }
    } catch (e) {
      console.error(`[CppFlow] Var error frame ${frameIndex}:`, e.message);
    }
    
    return locals;
  }

  _describeEvent(functionName, line) {
    return `${functionName}() line ${line}`;
  }

  _extractContainers(stackData) {
    const containers = {
      arrays: [], maps: [], sets: [], stacks: [], queues: [],
      priorityQueues: [], lists: [], graphs: [], unknowns: []
    };

    for (const frame of stackData) {
      for (const local of frame.locals || []) {
        const type = (local.type || '').toLowerCase();
        const value = local.value || '';
        const name = local.name;

        // Vector / Array
        if (type.includes('vector') || type.includes('array') || type.includes('[]')) {
          const values = this._parseContainerValues(value, local.children);
          containers.arrays.push({ name, kind: 'vector', values });
        }
        // Map
        else if (type.includes('map') || type.includes('dictionary')) {
          const entries = this._parseMapEntries(value, local.children);
          containers.maps.push({ name, kind: 'map', entries });
        }
        // Set
        else if (type.includes('set') && !type.includes('unordered_set')) {
          const values = this._parseContainerValues(value, local.children);
          containers.sets.push({ name, kind: 'set', values });
        }
        // Stack
        else if (type.includes('stack')) {
          const values = this._parseContainerValues(value, local.children);
          containers.stacks.push({ name, values });
        }
        // Queue
        else if (type.includes('queue') && !type.includes('priority')) {
          const values = this._parseContainerValues(value, local.children);
          containers.queues.push({ name, values });
        }
        // Priority Queue
        else if (type.includes('priority_queue')) {
          const values = this._parseContainerValues(value, local.children);
          containers.priorityQueues.push({ name, values });
        }
        // List
        else if (type.includes('list') && !type.includes('initializer')) {
          const values = this._parseContainerValues(value, local.children);
          containers.lists.push({ name, values });
        }
        // Graph (adjacency list/map)
        else if (type.includes('graph') || (local.children && this._looksLikeGraph(local.children))) {
          const edges = this._parseGraphEdges(local.children);
          containers.graphs.push({ name, edges });
        }
        // Pointer / Memory
        else if (type.includes('*') || type.includes('ptr') || value.includes('0x')) {
          // Handled in memory view
        }
      }
    }

    return containers;
  }

  _parseContainerValues(valueStr, children) {
    if (children && children.length > 0) {
      return children.map(c => c.value || c.name);
    }
    // Try to parse from string like "{1, 2, 3}" or "[1] = 5, [2] = 10"
    try {
      const values = [];
      // Match array elements
      const matches = valueStr.matchAll(/\[\d+\]\s*=\s*([^,]+)/g);
      for (const m of matches) {
        values.push(m[1].trim());
      }
      if (values.length > 0) return values;
      
      // Match {a, b, c} format
      const braceMatch = valueStr.match(/\{(.+)\}/);
      if (braceMatch) {
        return braceMatch[1].split(',').map(s => s.trim()).filter(s => s);
      }
      
      return [valueStr];
    } catch {
      return [valueStr];
    }
  }

  _parseMapEntries(valueStr, children) {
    if (children && children.length > 0) {
      return children.map(c => {
        const parts = (c.value || '').split(':').map(s => s.trim());
        return parts.length === 2 ? parts : [c.name, c.value];
      });
    }
    return [];
  }

  _looksLikeGraph(children) {
    // Check if children look like adjacency list
    return children.some(c => c.value && c.value.includes('->'));
  }

  _parseGraphEdges(children) {
    return children.map(c => {
      const neighbors = (c.value || '').split(/[,;]/).map(s => s.trim()).filter(s => s);
      return [c.name, neighbors];
    });
  }

  _buildFlowTree(stackData) {
    const nodes = [];
    const edges = [];
    const nodeIds = new Set();

    for (let i = 0; i < stackData.length; i++) {
      const frame = stackData[i];
      const nodeId = `${frame.name}#${i}`;
      
      if (!nodeIds.has(nodeId)) {
        nodeIds.add(nodeId);
        nodes.push({
          id: nodeId,
          label: `${frame.name}()`,
          function: frame.name,
          params: frame.args || [],
          meta: `line ${frame.line}`,
          active: i === 0,
          done: false
        });
      }

      if (i > 0) {
        const parentId = `${stackData[i-1].name}#${i-1}`;
        edges.push({ from: parentId, to: nodeId });
      }
    }

    return { nodes, edges };
  }

  _markChangedValues(prevStep, currStep) {
    const prevVars = new Map();
    
    for (const frame of prevStep.stack) {
      for (const local of frame.locals) {
        prevVars.set(`${frame.id}:${local.name}`, local.value);
      }
    }

    for (const frame of currStep.stack) {
      for (const local of frame.locals) {
        const key = `${frame.id}:${local.name}`;
        local.changed = prevVars.get(key) !== local.value;
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════
   Activation
   ═══════════════════════════════════════════════════════ */
function activate(context) {
  // Open panel command
  const openPanelCmd = vscode.commands.registerCommand('cppFlow.openPanel', () => {
    if (!currentPanel) {
      currentPanel = new CppFlowPanel(context.extensionUri);
    } else {
      currentPanel.reveal();
    }
  });

  // Auto-open panel when debugger starts
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      console.log('[CppFlow] Debugger started:', session.name);
      
      if (!currentPanel) {
        currentPanel = new CppFlowPanel(context.extensionUri);
      }
      
      // Small delay to let debugger initialize
      setTimeout(() => {
        if (debugTracker) debugTracker.stop();
        debugTracker = new DebugTracker(currentPanel);
        debugTracker.start();
      }, 500);
    })
  );

  // Stop tracking when debugger ends
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      console.log('[CppFlow] Debugger ended');
      if (debugTracker) {
        debugTracker.stop();
        debugTracker = null;
      }
      if (currentPanel) {
        currentPanel.updateStatus('Disconnected', 'Debugger session ended');
      }
    })
  );

  // Track debug session changes
  context.subscriptions.push(
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      if (session && currentPanel) {
        currentPanel.updateStatus('Connected', `Session: ${session.name}`);
      }
    })
  );

  // Hover provider for variable values
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('cpp', {
      provideHover(document, position) {
        if (!currentPanel || currentStepIndex < 0) return;
        
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return;
        const word = document.getText(wordRange);
        
        const step = stepHistory[currentStepIndex];
        if (!step) return;

        for (const frame of step.stack || []) {
          for (const local of frame.locals || []) {
            if (local.name === word) {
              const md = new vscode.MarkdownString();
              md.appendCodeblock(`${local.name}: ${local.type} = ${local.value}`, 'cpp');
              if (local.children && local.children.length > 0) {
                md.appendMarkdown('\n\n**Elements:**\n');
                for (const child of local.children.slice(0, 10)) {
                  md.appendMarkdown(`- \`${child.name}\`: ${child.value}\n`);
                }
              }
              md.appendMarkdown(`\n\n*Frame:* \`${frame.name}\`  |  *Line:* ${step.line}`);
              md.isTrusted = true;
              return new vscode.Hover(md, wordRange);
            }
          }
        }
        return undefined;
      }
    })
  );

  context.subscriptions.push(openPanelCmd);
}

function deactivate() {
  if (debugTracker) {
    debugTracker.stop();
  }
}

module.exports = { activate, deactivate };