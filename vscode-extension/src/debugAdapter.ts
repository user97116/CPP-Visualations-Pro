import {
  DebugSession,
  InitializedEvent,
  Thread,
  StoppedEvent,
  StackFrame,
  Scope,
  Source,
  Breakpoint,
  OutputEvent,
  TerminatedEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewPanel } from 'vscode';
import { sendTraceToWebview, sendStepToWebview } from './extension';
import fetch from 'node-fetch';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args: string[];
  cwd: string;
  stopOnEntry: boolean;
}

class PromiseResolver<T> {
  public resolve!: (value: T | PromiseLike<T>) => void;
  public reject!: (reason?: any) => void;
  private promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  public getPromise(): Promise<T> {
    return this.promise;
  }
}

export class CppFlowStudioDebugSession extends DebugSession {
  private static THREAD_ID = 1;
  private _configurationDone = new PromiseResolver<void>();
  private _pythonProcess: ChildProcessWithoutNullStreams | undefined;
  private _traceData: any = null;
  private _currentStepIndex: number = 0;
  private _webviewPanel: WebviewPanel | undefined;
  private _programPath: string = '';

  public constructor(webviewPanel: WebviewPanel | undefined) {
    super();
    this._webviewPanel = webviewPanel;
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsBreakpointLocationsRequest = true;

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    super.configurationDoneRequest(response, args);
    this._configurationDone.resolve();
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): Promise<void> {
    await this._configurationDone.getPromise();

    this._programPath = path.resolve(args.cwd, args.program);
    const pythonServerPath = path.resolve(__dirname, '../../server.py');

    this.sendEvent(new OutputEvent(`Launching Python server: ${pythonServerPath}\n`));
    this.sendEvent(new OutputEvent(`Debugging program: ${this._programPath}\n`));

    this._pythonProcess = spawn('python3', [pythonServerPath]);

    this._pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      this.sendEvent(new OutputEvent(output));
      if (output.includes('Serving C++ Flow Studio')) {
        this.sendEvent(new OutputEvent('Python server is ready.\n'));
        this.startTracing(this._programPath);
      }
    });

    this._pythonProcess.stderr.on('data', (data) => {
      this.sendEvent(new OutputEvent(`Python server error: ${data.toString()}`));
    });

    this._pythonProcess.on('close', (code) => {
      this.sendEvent(new OutputEvent(`Python server exited with code ${code}\n`));
      this.sendEvent(new TerminatedEvent());
    });

    response.success = true;
    this.sendResponse(response);
  }

  private async startTracing(programPath: string): Promise<void> {
    if (!this._pythonProcess) {
      this.sendEvent(new OutputEvent('Error: Python server not running.\n'));
      return;
    }

    let cppCode: string;
    try {
      const uri = vscode.Uri.file(programPath);
      const fileContent = await vscode.workspace.fs.readFile(uri);
      cppCode = Buffer.from(fileContent).toString('utf8');
    } catch (error: any) {
      this.sendEvent(new OutputEvent(`Error reading C++ file: ${error.message}\n`));
      this.sendEvent(new TerminatedEvent());
      return;
    }

    this.sendEvent(new OutputEvent(`Sending trace request for ${programPath}...
`));

    try {
      const response = await fetch('http://127.0.0.1:8000/api/trace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: cppCode })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server responded with status ${response.status}: ${errorText}`);
      }

      const traceData: any = await response.json();
      this._traceData = { ...(traceData as object), programPath: programPath };
      this._currentStepIndex = 0;

      if (this._webviewPanel) {
        sendTraceToWebview(this._traceData);
        sendStepToWebview(this._currentStepIndex);
      }

      this.sendEvent(new StoppedEvent('entry', CppFlowStudioDebugSession.THREAD_ID));
    } catch (error: any) {
      this.sendEvent(new OutputEvent(`Error during tracing: ${error.message}\n`));
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: [new Thread(CppFlowStudioDebugSession.THREAD_ID, 'main thread')]
    };
    this.sendResponse(response);
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    if (!this._traceData || !this._traceData.steps || this._traceData.steps.length === 0) {
      response.body = { stackFrames: [], totalFrames: 0 };
      this.sendResponse(response);
      return;
    }

    const step = this._traceData.steps[this._currentStepIndex];
    const stackFrames: StackFrame[] = [];

    if (step && step.stack) {
      for (let i = 0; i < step.stack.length; i++) {
        const frame = step.stack[i];
        stackFrames.push(
          new StackFrame(
            i,
            frame.name,
            new Source(path.basename(this._traceData.programPath || 'program.cpp')),
            step.line,
            0
          )
        );
      }
    }

    response.body = {
      stackFrames: stackFrames,
      totalFrames: stackFrames.length
    };
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    response.body = {
      scopes: [new Scope('Locals', 1000, false)]
    };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): void {
    const variables: DebugProtocol.Variable[] = [];

    if (this._traceData && this._traceData.steps && this._traceData.steps.length > 0) {
      const step = this._traceData.steps[this._currentStepIndex];
      if (step && step.stack && step.stack.length > 0) {
        const activeFrame = step.stack[0];
        if (activeFrame.locals) {
          for (const local of activeFrame.locals) {
            variables.push({
              name: local.name,
              type: typeof local.value,
              value: String(local.value),
              variablesReference: 0
            });
          }
        }
      }
    }

    response.body = { variables: variables };
    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    if (this._traceData && this._currentStepIndex < this._traceData.steps.length - 1) {
      this._currentStepIndex++;
      sendStepToWebview(this._currentStepIndex);
      this.sendEvent(new StoppedEvent('step', CppFlowStudioDebugSession.THREAD_ID));
    } else {
      this.sendEvent(new TerminatedEvent());
    }
    this.sendResponse(response);
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    if (this._traceData && this._currentStepIndex < this._traceData.steps.length - 1) {
      this._currentStepIndex++;
      sendStepToWebview(this._currentStepIndex);
      this.sendEvent(new StoppedEvent('step', CppFlowStudioDebugSession.THREAD_ID));
    } else {
      this.sendEvent(new TerminatedEvent());
    }
    this.sendResponse(response);
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this.nextRequest(response, args);
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
    this.nextRequest(response, args);
  }

  protected setBreakpointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    const breakpoints: Breakpoint[] = [];
    if (args.source.path && args.breakpoints) {
      for (const bp of args.breakpoints) {
        breakpoints.push(new Breakpoint(true, bp.line));
      }
    }
    response.body = { breakpoints: breakpoints };
    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments
  ): void {
    if (this._pythonProcess) {
      this._pythonProcess.kill();
      this._pythonProcess = undefined;
    }
    super.disconnectRequest(response, args);
  }
}
