const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let currentPanel = null;
let debugTracker = null;

/* ═══════════════════════════════════════════════════════
   CppFlowPanel — same as before
   ═══════════════════════════════════════════════════════ */
class CppFlowPanel {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.currentStep = null;
    this.currentStepIndex = 0;
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
    this.panel.onDidDispose(() => { this.panel = undefined; });
  }

  reveal() {
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside);
  }

  setTrace(trace) {
    if (this._webviewReady && this.panel) {
      this.panel.webview.postMessage({ type: 'traceResult', trace });
    } else {
      this._pendingTrace = trace;
    }
  }

  _handleMessage(message) {
    if (message.type === 'webviewReady') {
      this._webviewReady = true;
      if (this._pendingTrace && this.panel) {
        this.panel.webview.postMessage({ type: 'traceResult', trace: this._pendingTrace });
        this._pendingTrace = null;
      }
      return;
    }
    if (message.type === 'stepChanged') {
      this.currentStepIndex = message.stepIndex;
      this.currentStep = message.step;
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
</head>
<body>
  <div class="app-shell">
    <div class="workspace-layout">
      <div class="trace-column">
        <div class="panel editor-panel">
          <div class="panel-header">
            <div><div class="eyebrow">Source</div><h2>Active Editor</h2></div>
            <button id="run-visualizer" class="primary-button">Connect to Debugger</button>
          </div>
          <div style="margin-top:16px;padding:18px;border-radius:18px;background:rgba(7,14,26,0.9);border:1px solid rgba(142,170,217,0.16);font-family:var(--font-code);font-size:0.9rem;color:var(--muted);min-height:120px;">
            Start VS Code debugger (F5) for C++, then click <strong>Connect to Debugger</strong> to visualize live execution.
          </div>
          <div class="hint-row"><span>Auto-synced from VS Code debugger</span></div>
          <textarea id="code-editor" style="display:none;"></textarea>
        </div>
        <div class="panel stage-panel">
          <div class="exec-banner" id="exec-banner">
            <span class="exec-banner__line" id="exec-banner-line">—</span>
            <span class="exec-banner__code" id="exec-banner-code">Waiting for debugger</span>
            <span class="exec-banner__event" id="exec-banner-event"></span>
          </div>
          <div class="panel-header trace-header-panel">
            <div><div class="eyebrow" id="trace-title">Live Debugger</div><h2 id="event-indicator">Not connected</h2></div>
            <div class="toggles">
              <label class="toggle"><input type="checkbox" id="filter-unchanged"> Hide unchanged</label>
              <label class="toggle"><input type="checkbox" id="focus-mode"> Focus mode</label>
            </div>
          </div>
          <div class="progress-card">
            <div class="panel-header">
              <div><div class="eyebrow">Step</div><strong id="step-indicator">0 / 0</strong></div>
              <div id="line-indicator">-</div>
            </div>
            <input type="range" id="step-slider" min="0" max="0" value="0">
            <div class="step-summary" id="step-summary">Start debugging in VS Code to see live visualization.</div>
          </div>
          <div class="code-visual" id="code-visual"></div>
        </div>
      </div>
      <div class="layout">
        <div class="panel">
          <div class="eyebrow">Surface</div>
          <div class="surface-strip">
            <div class="surface-stat"><span class="eyebrow">Stack depth</span><strong id="surface-stack-count">0</strong></div>
            <div class="surface-stat"><span class="eyebrow">Flow nodes</span><strong id="surface-flow-count">0</strong></div>
            <div class="surface-stat"><span class="eyebrow">Containers</span><strong id="surface-container-count">0</strong></div>
            <div class="surface-stat wide"><span class="eyebrow">Focus</span><strong id="surface-focus">Waiting</strong></div>
          </div>
        </div>
        <div class="insights-grid">
          <div class="subpanel collections-panel">
            <div class="subpanel-title-row"><h3>Collections</h3><span id="container-context-label">Vector, map, set, stack, graph, list renderers</span></div>
            <div class="containers-view" id="containers-view"></div>
          </div>
          <div class="subpanel stack-panel">
            <div class="subpanel-title-row"><h3>Stack</h3><span>frames</span></div>
            <div class="stack-view" id="stack-view"></div>
          </div>
          <div class="subpanel flow-panel">
            <div class="subpanel-title-row"><h3>Flow</h3><div class="flow-controls"><button id="toggle-flow-graph" class="ghost-button small">Hide graph</button><button id="toggle-flow-list" class="ghost-button small">Hide details</button></div></div>
            <div class="flow-view" id="flow-view"></div>
          </div>
          <div class="subpanel memory-panel">
            <div class="subpanel-title-row"><h3>Memory</h3><button id="visualize-addresses" class="ghost-button small">Visualize</button></div>
            <div class="memory-view" id="memory-view"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="playback-dock">
      <button id="prev-step" class="icon-button" disabled>←</button>
      <button id="play-pause" class="primary-button small" disabled>Pause</button>
      <button id="next-step" class="icon-button" disabled>→</button>
    </div>
    <div class="output-panel">
      <div class="output-panel-header"><h3>Program Output</h3><span class="output-badge" id="output-badge">stdout</span></div>
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
   DebugTracker — VS Code debugger se connect karta hai
   ═══════════════════════════════════════════════════════ */
class DebugTracker {
  constructor(panel) {
    this.panel = panel;
    this.steps = [];
    this.stepIndex = -1;
    this.isTracking = false;
    this.disposables = [];
  }

  start() {
    if (this.isTracking) return;
    this.isTracking = true;
    this.steps = [];
    this.stepIndex = -1;

    // Listen for debug session start
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        console.log('[CppFlow] Debug session started:', session.name);
        this._notifyPanel('Debugger connected', 'Session started');
      })
    );

    // Listen for debug session end
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        console.log('[CppFlow] Debug session ended:', session.name);
        this.isTracking = false;
        this._notifyPanel('Debugger disconnected', 'Session ended');
      })
    );

    // Listen for breakpoint hit / step complete
    this.disposables.push(
      vscode.debug.onDidChangeActiveStackItem(async () => {
        await this._captureState();
      })
    );

    // Listen for stopped event (breakpoint, step, exception)
    this.disposables.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(async (e) => {
        if (e.event === 'stopped') {
          await this._captureState();
        }
      })
    );

    // Also poll when debugger is active
    this._startPolling();
  }

  stop() {
    this.isTracking = false;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  _startPolling() {
    const interval = setInterval(async () => {
      if (!this.isTracking) {
        clearInterval(interval);
        return;
      }
      if (vscode.debug.activeDebugSession) {
        await this._captureState();
      }
    }, 100); // Poll every 100ms when debugger is active
  }

  async _captureState() {
    const session = vscode.debug.activeDebugSession;
    if (!session) return;

    try {
      // Get stack trace
      const stackTrace = await session.customRequest('stackTrace', { threadId: 1 });
      const frames = stackTrace.stackFrames || [];

      // Get current line from top frame
      const topFrame = frames[0];
      if (!topFrame) return;

      const currentLine = topFrame.line;
      const currentFile = topFrame.source?.path || 'unknown';
      const functionName = topFrame.name || 'unknown';

      // Get variables for each frame
      const stackData = [];
      for (let i = 0; i < Math.min(frames.length, 5); i++) {
        const frame = frames[i];
        const frameId = frame.id;

        // Get scopes for this frame
        const scopes = await session.customRequest('scopes', { frameId });
        const scope = scopes.scopes[0]; // Usually Local scope

        // Get variables in this scope
        const vars = await session.customRequest('variables', { variablesReference: scope.variablesReference });
        
        const locals = vars.variables.map(v => ({
          name: v.name,
          value: v.value,
          type: v.type,
          changed: false // We'll track this manually
        }));

        stackData.push({
          id: `${frame.name}|${i}`,
          name: frame.name,
          line: frame.line,
          active: i === 0,
          status: i === 0 ? 'active' : 'waiting',
          locals: locals,
          args: []
        });
      }

      // Build step data
      const step = {
        line: currentLine,
        event: `Execute line ${currentLine} in ${functionName}`,
        summary: `${functionName} at line ${currentLine}`,
        stdout: '',
        stack: stackData,
        containers: this._extractContainers(stackData),
        activeContainers: this._extractContainers([stackData[0]]),
        memory: { nodes: [], edges: [] },
        tree: this._buildFlowTree(stackData, currentLine)
      };

      // Check if this is a new step (different line)
      const lastStep = this.steps[this.steps.length - 1];
      if (!lastStep || lastStep.line !== currentLine) {
        this.steps.push(step);
        this.stepIndex = this.steps.length - 1;
        
        // Mark changed variables
        if (lastStep) {
          this._markChangedValues(lastStep, step);
        }

        // Send to panel
        this._sendToPanel();
      }

    } catch (err) {
      console.error('[CppFlow] Debug capture error:', err.message);
    }
  }

  _extractContainers(stackData) {
    const containers = {
      arrays: [], maps: [], sets: [], stacks: [], queues: [],
      priorityQueues: [], lists: [], graphs: [], unknowns: []
    };

    for (const frame of stackData) {
      for (const local of frame.locals || []) {
        const type = local.type || '';
        const value = local.value || '';

        // Try to detect container types from debugger output
        if (type.includes('vector') || type.includes('std::vector')) {
          const values = this._parseArrayValue(value);
          containers.arrays.push({ name: local.name, kind: 'vector', values });
        } else if (type.includes('map') || type.includes('std::map')) {
          const entries = this._parseMapValue(value);
          containers.maps.push({ name: local.name, kind: 'map', entries });
        } else if (type.includes('set') || type.includes('std::set')) {
          const values = this._parseArrayValue(value);
          containers.sets.push({ name: local.name, kind: 'set', values });
        } else if (type.includes('stack') || type.includes('std::stack')) {
          const values = this._parseArrayValue(value);
          containers.stacks.push({ name: local.name, values });
        }
        // Add more container types as needed
      }
    }

    return containers;
  }

  _parseArrayValue(valueStr) {
    // Parse debugger output like "{1, 2, 3}" or "[1, 2, 3]"
    try {
      const match = valueStr.match(/[\{\[](.+)[\}\]]/);
      if (!match) return [];
      return match[1].split(',').map(s => s.trim()).filter(s => s);
    } catch {
      return [];
    }
  }

  _parseMapValue(valueStr) {
    try {
      const entries = [];
      const match = valueStr.match(/[\{\[](.+)[\}\]]/);
      if (!match) return [];
      const pairs = match[1].split(',');
      for (const pair of pairs) {
        const [key, val] = pair.split(':').map(s => s.trim());
        if (key && val) entries.push([key, val]);
      }
      return entries;
    } catch {
      return [];
    }
  }

  _buildFlowTree(stackData, currentLine) {
    const nodes = [];
    const edges = [];

    for (let i = 0; i < stackData.length; i++) {
      const frame = stackData[i];
      const nodeId = `${frame.name}@${frame.line}`;
      
      nodes.push({
        id: nodeId,
        label: `${frame.name}()`,
        function: frame.name,
        params: frame.args,
        meta: `line ${frame.line}`,
        active: i === 0,
        done: false
      });

      if (i > 0) {
        const parentId = `${stackData[i-1].name}@${stackData[i-1].line}`;
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

  _sendToPanel() {
    if (!this.panel || !this.panel.panel) return;

    const trace = {
      title: 'Live VS Code Debugger',
      code: this._getActiveEditorCode(),
      stdout: '',
      steps: this.steps
    };

    this.panel.panel.webview.postMessage({
      type: 'traceResult',
      trace: trace
    });
  }

  _notifyPanel(event, message) {
    if (!this.panel || !this.panel.panel) return;
    this.panel.panel.webview.postMessage({
      type: 'debugStatus',
      event: event,
      message: message
    });
  }

  _getActiveEditorCode() {
    const editor = vscode.window.activeTextEditor;
    return editor ? editor.document.getText() : '';
  }
}

/* ═══════════════════════════════════════════════════════
   Activation
   ═══════════════════════════════════════════════════════ */
function activate(context) {
  // Create panel command
  const openPanelCmd = vscode.commands.registerCommand('cppFlow.openPanel', () => {
    if (!currentPanel) {
      currentPanel = new CppFlowPanel(context.extensionUri);
      currentPanel.panel.onDidDispose(() => { currentPanel = null; });
    } else {
      currentPanel.reveal();
    }
  });

  // Connect to debugger command
  const connectCmd = vscode.commands.registerCommand('cppFlow.connectDebugger', async () => {
    if (!currentPanel) {
      currentPanel = new CppFlowPanel(context.extensionUri);
      currentPanel.panel.onDidDispose(() => { currentPanel = null; });
    }

    // Check if debugger is running
    if (!vscode.debug.activeDebugSession) {
      vscode.window.showWarningMessage('Pehle VS Code debugger start karo (F5), phir connect karo.');
      return;
    }

    if (debugTracker) {
      debugTracker.stop();
    }

    debugTracker = new DebugTracker(currentPanel);
    debugTracker.start();

    vscode.window.showInformationMessage('C++ Flow Studio connected to VS Code debugger!');
  });

  // Auto-connect when debugger starts
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(() => {
      if (currentPanel && !debugTracker) {
        debugTracker = new DebugTracker(currentPanel);
        debugTracker.start();
      }
    })
  );

  // Clean up when debugger stops
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      if (debugTracker) {
        debugTracker.stop();
        debugTracker = null;
      }
    })
  );

  // Hover provider
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('cpp', {
      provideHover(document, position) {
        if (!currentPanel || !currentPanel.currentStep) return;
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return;
        const word = document.getText(wordRange);
        const step = currentPanel.currentStep;

        for (const frame of step.stack || []) {
          for (const local of frame.locals || []) {
            if (local.name === word) {
              const md = new vscode.MarkdownString();
              md.appendCodeblock(`${local.name} = ${JSON.stringify(local.value)}`, 'cpp');
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

  context.subscriptions.push(openPanelCmd, connectCmd);
}

function deactivate() {
  if (debugTracker) {
    debugTracker.stop();
  }
}

module.exports = { activate, deactivate };