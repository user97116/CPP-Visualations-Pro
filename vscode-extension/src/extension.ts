import * as vscode from 'vscode';
import { CppFlowStudioDebugSession } from './debugAdapter';
import { WebviewPanel } from 'vscode';

let flowStudioPanel: WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('C++ Flow Studio Debugger extension is now active!');

  // Register the command to open the Flow Studio Webview
  context.subscriptions.push(
    vscode.commands.registerCommand('cpp-flow-studio-debugger.startFlowStudio', () => {
      if (flowStudioPanel) {
        flowStudioPanel.reveal(vscode.ViewColumn.Beside);
      } else {
        flowStudioPanel = vscode.window.createWebviewPanel(
          'cppFlowStudio',
          'C++ Flow Studio',
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webview')]
          }
        );

        const webviewPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webview');
        const htmlPath = vscode.Uri.joinPath(webviewPath, 'index.html');
        const styleUri = flowStudioPanel.webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'styles.css'));
        const scriptUri = flowStudioPanel.webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'app.js'));

        vscode.workspace.fs.readFile(htmlPath).then(async (data) => {
          let htmlContent = data.toString();
          htmlContent = htmlContent.replace('./styles.css', styleUri.toString());
          htmlContent = htmlContent.replace('./app.js', scriptUri.toString());
          flowStudioPanel!.webview.html = htmlContent;
        });

        flowStudioPanel.onDidDispose(
          () => {
            flowStudioPanel = undefined;
          },
          undefined,
          context.subscriptions
        );

        flowStudioPanel.webview.onDidReceiveMessage(
          message => {
            switch (message.command) {
              case 'alert':
                vscode.window.showInformationMessage(message.text);
                return;
            }
          },
          undefined,
          context.subscriptions
        );
      }
    })
  );

  // Register the debug configuration provider
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'cpp-flow-studio',
      new CppFlowStudioConfigurationProvider()
    )
  );

  // Register the debug adapter descriptor factory
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      'cpp-flow-studio',
      new CppFlowStudioDebugAdapterDescriptorFactory()
    )
  );
}

export function deactivate() {
  if (flowStudioPanel) {
    flowStudioPanel.dispose();
  }
}

class CppFlowStudioConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'cpp') {
        config.type = 'cpp-flow-studio';
        config.name = 'Launch C++ Flow Studio';
        config.request = 'launch';
        config.program = '${file}';
        config.args = [];
        config.cwd = '${workspaceFolder}';
        config.stopOnEntry = true;
      }
    }

    if (!config.program) {
      return vscode.window.showInformationMessage('Cannot find a program to debug').then(() => undefined);
    }

    return config;
  }
}

class CppFlowStudioDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    // In this example, we are running the debug adapter as a separate process
    // You would typically launch your Python server here.
    // For now, we'll simulate it or point to a dummy executable.
    // The actual communication with the Python server will happen within the CppFlowStudioDebugSession.
    return new vscode.DebugAdapterInlineImplementation(new CppFlowStudioDebugSession(flowStudioPanel));
  }
}

// Function to send trace data to the Webview
export function sendTraceToWebview(traceData: any) {
  if (flowStudioPanel) {
    flowStudioPanel.webview.postMessage({ command: 'updateTrace', trace: traceData });
  }
}

// Function to send current step to the Webview
export function sendStepToWebview(stepIndex: number) {
  if (flowStudioPanel) {
    flowStudioPanel.webview.postMessage({ command: 'updateStep', stepIndex: stepIndex });
  }
}