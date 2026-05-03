const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class CppFlowPanel {
  constructor(extensionUri, serverManager) {
    this.extensionUri = extensionUri;
    this.serverManager = serverManager;
    this.currentStep = null;
    this.currentStepIndex = 0;
    this._webviewReady = false;
    this._pendingTrace = null;
    this._pendingCode = null;

    this.panel = vscode.window.createWebviewPanel(
      'cppFlow',
      'C++ Flow Studio',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          extensionUri
        ]
      }
    );

    this.panel.webview.html = this._getHtml();

    this.panel.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg),
      undefined,
      []
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  reveal() {
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside);
  }

  setTrace(trace, code) {
    if (this._webviewReady && this.panel) {
      this.panel.webview.postMessage({ type: 'traceResult', trace });
      if (code !== undefined) this.panel.webview.postMessage({ type: 'loadCode', code });
    } else {
      this._pendingTrace = trace;
      this._pendingCode = code;
    }
  }

  async _handleMessage(message) {
    if (message.type === 'webviewReady') {
      this._webviewReady = true;
      if (this._pendingTrace && this.panel) {
        this.panel.webview.postMessage({ type: 'traceResult', trace: this._pendingTrace });
        if (this._pendingCode !== undefined) {
          this.panel.webview.postMessage({ type: 'loadCode', code: this._pendingCode });
        }
        this._pendingTrace = null;
        this._pendingCode = null;
      }
      return;
    }

    if (message.type === 'stepChanged') {
      this.currentStepIndex = message.stepIndex;
      this.currentStep = message.step;
      return;
    }

    if (message.type !== 'trace') return;

    try {
      const editor = vscode.window.activeTextEditor;
      const code = editor ? editor.document.getText() : '';
      if (!code.trim()) {
        this.panel.webview.postMessage({ type: 'traceError', error: 'Koi .cpp file open nahi hai.' });
        return;
      }
      const trace = await this.serverManager.trace(code);
      this.panel.webview.postMessage({ type: 'traceResult', trace });
      this.panel.webview.postMessage({ type: 'loadCode', code });
    } catch (err) {
      this.panel.webview.postMessage({ type: 'traceError', error: err.message || 'Trace failed' });
    }
  }

  _getHtml() {
    const webview = this.panel.webview;

    // media folder auto-detect (root ya media/ dono chalega)
    const candidates = [
      path.join(this.extensionUri.fsPath, 'media'),
      this.extensionUri.fsPath
    ];
    const mediaDir = candidates.find(p =>
      fs.existsSync(path.join(p, 'styles.css')) && fs.existsSync(path.join(p, 'app.js'))
    );

    const baseUri = mediaDir
      ? webview.asWebviewUri(vscode.Uri.file(mediaDir))
      : webview.asWebviewUri(this.extensionUri);

    const styleUri = vscode.Uri.joinPath(baseUri, 'styles.css');
    const scriptUri = vscode.Uri.joinPath(baseUri, 'app.js');
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
            <div>
              <div class="eyebrow">Source</div>
              <h2>Active Editor</h2>
            </div>
            <button id="run-visualizer" class="primary-button">Trace Active File</button>
          </div>
          <div style="margin-top:16px;padding:18px;border-radius:18px;background:rgba(7,14,26,0.9);border:1px solid rgba(142,170,217,0.16);font-family:var(--font-code);font-size:0.9rem;color:var(--muted);min-height:120px;">
            Code automatically synced from VS Code active editor. Click <strong>Trace Active File</strong> to visualize.
          </div>
          <div class="hint-row">
            <span>Auto-synced from VS Code active editor</span>
          </div>
          <textarea id="code-editor" style="display:none;"></textarea>
        </div>

        <div class="panel stage-panel">
          <div class="exec-banner" id="exec-banner">
            <span class="exec-banner__line" id="exec-banner-line">—</span>
            <span class="exec-banner__code" id="exec-banner-code">Waiting for trace</span>
            <span class="exec-banner__event" id="exec-banner-event"></span>
          </div>

          <div class="panel-header trace-header-panel">
            <div>
              <div class="eyebrow" id="trace-title">Real LLDB Trace</div>
              <h2 id="event-indicator">Waiting for a run</h2>
            </div>
            <div class="toggles">
              <label class="toggle"><input type="checkbox" id="filter-unchanged"> Hide unchanged</label>
              <label class="toggle"><input type="checkbox" id="focus-mode"> Focus mode</label>
            </div>
          </div>

          <div class="progress-card">
            <div class="panel-header">
              <div>
                <div class="eyebrow">Step</div>
                <strong id="step-indicator">0 / 0</strong>
              </div>
              <div id="line-indicator">-</div>
            </div>
            <input type="range" id="step-slider" min="0" max="0" value="0">
            <div class="step-summary" id="step-summary">Open a C++ file and run the visualizer to inspect execution flow.</div>
          </div>

          <div class="code-visual" id="code-visual"></div>
        </div>
      </div>

      <div class="layout">
        <div class="panel">
          <div class="eyebrow">Surface</div>
          <div class="surface-strip">
            <div class="surface-stat">
              <span class="eyebrow">Stack depth</span>
              <strong id="surface-stack-count">0</strong>
            </div>
            <div class="surface-stat">
              <span class="eyebrow">Flow nodes</span>
              <strong id="surface-flow-count">0</strong>
            </div>
            <div class="surface-stat">
              <span class="eyebrow">Containers</span>
              <strong id="surface-container-count">0</strong>
            </div>
            <div class="surface-stat wide">
              <span class="eyebrow">Focus</span>
              <strong id="surface-focus">Waiting for a run</strong>
            </div>
          </div>
        </div>

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

    <div class="playback-dock">
      <button id="prev-step" class="icon-button">←</button>
      <button id="play-pause" class="primary-button small">Play</button>
      <button id="next-step" class="icon-button">→</button>
    </div>

    <div class="output-panel">
      <div class="output-panel-header">
        <h3>Program Output</h3>
        <span class="output-badge" id="output-badge">stdout</span>
      </div>
      <pre class="output-pre empty" id="program-output">No output yet.</pre>
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
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

module.exports = { CppFlowPanel };