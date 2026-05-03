import * as vscode from "vscode";

const VIEW_ID = "cppFlowStudio.flowView";

export function activate(context: vscode.ExtensionContext) {
  const provider = new FlowStudioViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        return {
          onDidSendMessage: (msg: DapMessage) => {
            if (msg.type === "event" && msg.event === "stopped") {
              const threadId = (msg.body as { threadId?: number })?.threadId;
              if (threadId != null) {
                provider.noteThreadId(threadId);
              }
              void provider.pushDebugState(session, threadId ?? provider.getThreadId(), "stopped");
            } else if (msg.type === "event" && msg.event === "continued") {
              void provider.pushContinued(session);
            }
          },
        };
      },
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      provider.clearDebugSession();
    })
  );
}

export function deactivate() {}

type DapMessage = {
  type: string;
  event?: string;
  body?: unknown;
};

type FlowLocal = { name: string; value: string; changed: boolean; isReturn?: boolean };

type FlowContainers = ReturnType<typeof emptyContainers>;

type FlowFrame = {
  depth: number;
  name: string;
  args: string[];
  line: number;
  id: string;
  status: string;
  active: boolean;
  locals: FlowLocal[];
  containers: FlowContainers;
  memory: { nodes: unknown[]; edges: unknown[] };
};

function emptyContainers() {
  return {
    arrays: [] as unknown[],
    maps: [] as unknown[],
    sets: [] as unknown[],
    stacks: [] as unknown[],
    queues: [] as unknown[],
    priorityQueues: [] as unknown[],
    lists: [] as unknown[],
    graphs: [] as unknown[],
    unknowns: [] as unknown[],
  };
}

function emptyMemory() {
  return { nodes: [] as unknown[], edges: [] as unknown[] };
}

class FlowStudioViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** Last thread from a `stopped` DAP event (used when refreshing the webview). */
  private lastThreadId = 1;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "ready" && vscode.debug.activeDebugSession) {
        void this.pushDebugState(vscode.debug.activeDebugSession, this.getThreadId(), "stopped");
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && vscode.debug.activeDebugSession) {
        void this.pushDebugState(vscode.debug.activeDebugSession, this.getThreadId(), "stopped");
      }
    });
  }

  noteThreadId(threadId: number) {
    this.lastThreadId = threadId;
  }

  getThreadId() {
    return this.lastThreadId;
  }

  clearDebugSession() {
    this.post({ type: "debugCleared" });
  }

  pushContinued(session: vscode.DebugSession) {
    this.post({
      type: "debugRunning",
      sessionName: session.name,
    });
  }

  async pushDebugState(session: vscode.DebugSession, threadId: number, reason: "stopped" | "continued") {
    if (!this.view) {
      return;
    }

    if (reason === "continued") {
      this.pushContinued(session);
      return;
    }

    try {
      const payload = await buildFlowPayload(session, threadId);
      this.post({
        type: "debugState",
        payload,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.post({
        type: "debugError",
        message,
      });
    }
  }

  private post(message: unknown) {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, "media");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "styles.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "webview.js"));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Flow Studio</title>
</head>
<body>
  <div class="app-shell">
    <main class="workspace-layout">
      <aside class="panel insights-panel">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">VS Code debug</p>
            <h2>State</h2>
          </div>
        </div>
        <div class="output-panel">
          <div class="output-panel-header">
            <h3>Program output</h3>
            <span class="output-badge" id="output-badge">stdout</span>
          </div>
          <pre id="program-output" class="output-pre empty">Start a debug session (F5). Flow Studio updates on each stop.</pre>
        </div>
        <div class="insights-grid">
          <div class="subpanel stack-panel">
            <div class="subpanel-title-row">
              <h3>Call stack</h3>
              <span>Hide variables and functions</span>
            </div>
            <div id="stack-view" class="stack-view"></div>
          </div>
          <div class="subpanel flow-panel">
            <div class="subpanel-title-row">
              <h3>Recursion flow</h3>
              <div class="flow-controls">
                <button id="toggle-flow-graph" class="frame-toggle">Hide graph</button>
                <button id="toggle-flow-list" class="frame-toggle">Hide details</button>
              </div>
            </div>
            <div id="flow-view" class="flow-view"></div>
          </div>
          <div class="subpanel memory-panel">
            <div class="subpanel-title-row">
              <h3>Address graph</h3>
              <button id="visualize-addresses" class="icon-button">Visualize</button>
            </div>
            <div id="memory-view" class="memory-view"></div>
          </div>
          <div class="subpanel collections-panel">
            <div class="subpanel-title-row">
              <h3>Containers</h3>
              <span id="container-context-label">Synced from debugger variables</span>
            </div>
            <div id="containers-view" class="containers-view"></div>
          </div>
        </div>
      </aside>
      <section class="trace-column">
        <div id="exec-banner" class="exec-banner exec-banner--idle">
          <span class="exec-banner__line" id="exec-banner-line">—</span>
          <code class="exec-banner__code" id="exec-banner-code">Waiting for debug stop</code>
          <span class="exec-banner__event" id="exec-banner-event"></span>
        </div>
        <section class="panel stage-panel">
          <div class="panel-header">
            <div>
              <p class="panel-kicker">Execution</p>
              <h2>Live trace</h2>
            </div>
            <div class="toggles">
              <label class="toggle">
                <input type="checkbox" id="filter-unchanged" />
                <span>Only changed values</span>
              </label>
              <label class="toggle">
                <input type="checkbox" id="focus-mode" checked />
                <span>Focus mode</span>
              </label>
            </div>
          </div>
          <div class="status-strip">
            <div>
              <span class="status-label">Session</span>
              <strong id="session-indicator">—</strong>
            </div>
            <div>
              <span class="status-label">Current line</span>
              <strong id="line-indicator">-</strong>
            </div>
            <div>
              <span class="status-label">Source</span>
              <strong id="source-indicator" class="source-indicator">—</strong>
            </div>
            <div>
              <span class="status-label">Reason</span>
              <strong id="event-indicator">Idle</strong>
            </div>
          </div>
          <p id="step-summary" class="step-summary">
            Press F5 to start debugging. Step or continue in VS Code; this panel follows the active stack and source.
          </p>
          <div class="code-visual" id="code-visual"></div>
        </section>
      </section>
    </main>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

}

async function buildFlowPayload(session: vscode.DebugSession, threadId: number) {
  const st = await session.customRequest("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 64,
  });
  const stackFrames = (st.stackFrames ?? []) as StackFrame[];

  const flowFrames: FlowFrame[] = [];
  let sourcePath = "";
  let currentLine = 1;
  let lineText = "";

  for (let i = 0; i < stackFrames.length; i++) {
    const sf = stackFrames[i];
    const name = sf.name ?? "(anonymous)";
    const line = sf.line ?? 0;
    const { args, locals } = await getFrameVariables(session, sf.id);

    const total = stackFrames.length;
    const bottomIndex = total - 1 - i;
    const id = `${name}|${bottomIndex}`;

    flowFrames.push({
      depth: i,
      name: cleanFunctionName(name),
      args,
      line,
      id,
      status: i === 0 ? "active" : "waiting",
      active: i === 0,
      locals,
      containers: emptyContainers(),
      memory: emptyMemory(),
    });

    if (i === 0 && sf.source?.path) {
      sourcePath = sf.source.path;
      currentLine = line || 1;
      const lines = await readFileLines(sf.source.path);
      lineText = lines[currentLine - 1]?.trim() ?? "";
    }
  }

  const codeLines =
    sourcePath && stackFrames[0]?.source?.path
      ? await readFileLines(stackFrames[0].source.path)
      : [];

  const code = codeLines.join("\n");
  const top = flowFrames[0];
  const event = top ? `Stopped in ${top.name}` : "Stopped";
  const summary = top
    ? `${top.name} at line ${currentLine}${lineText ? `: ${lineText}` : ""}`
    : "No stack frames";

  const step = {
    line: currentLine,
    event,
    summary,
    stdout: "",
    stack: flowFrames,
    containers: emptyContainers(),
    activeContainers: emptyContainers(),
    memory: top?.memory ?? emptyMemory(),
    tree: buildFlowTreeFromStack(flowFrames, currentLine),
  };

  return {
    sessionName: session.name,
    sessionType: session.type,
    sourcePath,
    stopReason: event,
    code,
    step,
  };
}

function cleanFunctionName(raw: string): string {
  const paren = raw.indexOf("(");
  return (paren > 0 ? raw.slice(0, paren) : raw).trim() || raw;
}

type StackFrame = {
  id: number;
  name?: string;
  line?: number;
  source?: { path?: string; name?: string; sourceReference?: number };
};

async function readFileLines(path: string): Promise<string[]> {
  try {
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText().split(/\r?\n/);
  } catch {
    return [];
  }
}

async function getFrameVariables(
  session: vscode.DebugSession,
  frameId: number
): Promise<{ args: string[]; locals: FlowLocal[] }> {
  const { scopes = [] } = await session.customRequest("scopes", { frameId });
  const argVars: FlowLocal[] = [];
  const localVars: FlowLocal[] = [];

  for (const scope of scopes as { name?: string; variablesReference: number; expensive?: boolean }[]) {
    if (!scope.variablesReference || scope.expensive) {
      continue;
    }
    const { variables = [] } = await session.customRequest("variables", {
      variablesReference: scope.variablesReference,
      filter: "named",
    });

    const isArgs = scope.name === "Arguments" || scope.name === "Argumente";

    for (const v of variables as { name: string; value?: string; type?: string }[]) {
      const display = formatVariableValue(v);
      const entry: FlowLocal = { name: v.name, value: display, changed: true };
      if (isArgs) {
        argVars.push(entry);
      } else {
        localVars.push(entry);
      }
    }
  }

  const args = argVars.map((v) => `${v.name}=${v.value}`);
  return { args, locals: localVars };
}

function formatVariableValue(v: { value?: string; type?: string }): string {
  if (v.value !== undefined && v.value !== "") {
    return v.value;
  }
  return v.type ? `<${v.type}>` : "?";
}

function buildFlowTreeFromStack(frames: FlowFrame[], currentLine: number) {
  if (!frames.length) {
    return { nodes: [] as object[], edges: [] as object[] };
  }
  const path = [...frames].reverse();
  const nodes = path.map((f, i) => {
    const id = `n${i}`;
    return {
      id,
      base_key: id,
      label: f.args.length ? `${f.name}(${f.args.join(", ")})` : f.name,
      function: f.name,
      params: f.args,
      meta: f.line ? `line ${f.line}` : `line ${currentLine}`,
      depth: i,
      parentId: i > 0 ? `n${i - 1}` : undefined,
      active: i === path.length - 1,
      done: false,
    };
  });
  const edges: { from: string; to: string }[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
  }
  return { nodes, edges };
}
