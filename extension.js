const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let currentPanel = null;

/* ═══════════════════════════════════════════════════════
   Python finder
   ═══════════════════════════════════════════════════════ */
function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      require('child_process').execSync(`${cmd} --version`, { encoding: 'utf8', timeout: 5000 });
      return cmd;
    } catch (e) { continue; }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════
   Direct trace — no HTTP server, uses --trace-only
   ═══════════════════════════════════════════════════════ */
async function runDirectTrace(code, extensionUri) {
  const pythonCmd = findPython();
  if (!pythonCmd) {
    throw new Error('Python nahi mila. python3 ya python install karo.');
  }

  const serverPath = path.join(extensionUri.fsPath, 'media', 'server.py');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`server.py nahi mila: ${serverPath}`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonCmd, [serverPath, '--trace-only'], {
      env: {
        ...process.env,
        CODE_INPUT: Buffer.from(code).toString('base64')
      },
      cwd: path.join(extensionUri.fsPath, 'media'),
      timeout: 60000
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      console.log(`[CppFlow stdout] ${d.toString().trim()}`);
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      console.error(`[CppFlow stderr] ${d.toString().trim()}`);
    });

    proc.on('error', (err) => {
      reject(new Error(`Process failed to start: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `Trace failed (exit code ${code}).\n\n` +
          `STDERR:\n${stderr || '(empty)'}\n\n` +
          `STDOUT:\n${stdout.slice(0, 500) || '(empty)'}`
        ));
        return;
      }

      try {
        // Find JSON in output (ignore any prefix text)
        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
          reject(new Error(`No JSON found in output.\nOutput: ${stdout.slice(0, 500)}`));
          return;
        }
        const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
        const result = JSON.parse(jsonStr);

        if (result.error) {
          reject(new Error(result.details ? `${result.error}\n${result.details}` : result.error));
          return;
        }

        resolve(result);
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}\nOutput: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════
   CppFlowPanel
   ═══════════════════════════════════════════════════════ */
class CppFlowPanel {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
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
          vscode.Uri.joinPath(extensionUri, 'media')
        ]
      }
    );

    this.panel.webview.html = this._getHtml();
    this.panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg), undefined, []);
    this.panel.onDidDispose(() => { this.panel = undefined; });
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

      this.panel.webview.postMessage({ type: 'traceLoading' });
      const trace = await runDirectTrace(code, this.extensionUri);
      this.panel.webview.postMessage({ type: 'traceResult', trace });
      this.panel.webview.postMessage({ type: 'loadCode', code });
    } catch (err) {
      this.panel.webview.postMessage({ type: 'traceError', error: err.message || 'Trace failed' });
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
            <button id="run-visualizer" class="primary-button">Trace Active File</button>
          </div>
          <div style="margin-top:16px;padding:18px;border-radius:18px;background:rgba(7,14,26,0.9);border:1px solid rgba(142,170,217,0.16);font-family:var(--font-code);font-size:0.9rem;color:var(--muted);min-height:120px;">
            Code auto-synced from VS Code. Click <strong>Trace Active File</strong> to visualize.
          </div>
          <div class="hint-row"><span>Auto-synced from VS Code active editor</span></div>
          <textarea id="code-editor" style="display:none;"></textarea>
        </div>
        <div class="panel stage-panel">
          <div class="exec-banner" id="exec-banner">
            <span class="exec-banner__line" id="exec-banner-line">—</span>
            <span class="exec-banner__code" id="exec-banner-code">Waiting for trace</span>
            <span class="exec-banner__event" id="exec-banner-event"></span>
          </div>
          <div class="panel-header trace-header-panel">
            <div><div class="eyebrow" id="trace-title">Real LLDB Trace</div><h2 id="event-indicator">Waiting for a run</h2></div>
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
            <div class="step-summary" id="step-summary">Open a C++ file and run the visualizer.</div>
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
      <button id="prev-step" class="icon-button">←</button>
      <button id="play-pause" class="primary-button small">Play</button>
      <button id="next-step" class="icon-button">→</button>
    </div>
    <div class="output-panel">
      <div class="output-panel-header"><h3>Program Output</h3><span class="output-badge" id="output-badge">stdout</span></div>
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
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/* ═══════════════════════════════════════════════════════
   Activation
   ═══════════════════════════════════════════════════════ */
function activate(context) {
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
          for (const arg of frame.args || []) {
            const m = arg.match(/^(\w+)\s*=\s*(.+)$/);
            if (m && m[1] === word) {
              const md = new vscode.MarkdownString();
              md.appendCodeblock(`${m[1]} = ${m[2]}`, 'cpp');
              md.appendMarkdown(`\n\n*Frame:* \`${frame.name}\` (argument)`);
              md.isTrusted = true;
              return new vscode.Hover(md, wordRange);
            }
          }
        }
        return undefined;
      }
    })
  );

  const cmd = vscode.commands.registerCommand('cppFlow.startDebugAndVisualize', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'cpp') {
      vscode.window.showErrorMessage('Pehle ek .cpp file kholo.');
      return;
    }
    const code = editor.document.getText();
    if (!code.trim()) {
      vscode.window.showErrorMessage('File khali hai.');
      return;
    }

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'C++ Flow Studio',
      cancellable: true
    }, async (progress, token) => {
      try {
        progress.report({ message: 'Compiling & tracing with LLDB...' });
        const trace = await runDirectTrace(code, context.extensionUri);
        if (token.isCancellationRequested) return;

        progress.report({ message: 'Opening panel...' });
        if (!currentPanel) {
          currentPanel = new CppFlowPanel(context.extensionUri);
          currentPanel.panel.onDidDispose(() => { currentPanel = null; });
        } else {
          currentPanel.reveal();
        }
        currentPanel.setTrace(trace, code);
      } catch (err) {
        vscode.window.showErrorMessage(`Flow Studio error: ${err.message || err}`);
        console.error('[CppFlow] Full error:', err);
        if (currentPanel) {
          currentPanel.panel.webview.postMessage({
            type: 'traceError',
            error: err.message || String(err)
          });
        }
      }
    });
  });

  context.subscriptions.push(cmd);
}

function deactivate() {}

module.exports = { activate, deactivate };