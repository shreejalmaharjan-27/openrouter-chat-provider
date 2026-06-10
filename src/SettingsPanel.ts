import vscode from 'vscode';
import { SecretsManager } from './SecretsManager';
import type { RegistrationResult } from './registry';
import { DEFAULT_SAFETY_PROMPT } from './commandSafety';
import { log } from './Logger';

type CurrentGetter = () => RegistrationResult | undefined;

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    secrets: SecretsManager,
    getCurrent: CurrentGetter,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SettingsPanel.instance) {
      SettingsPanel.instance.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'orcp.settings',
      'OpenRouter Settings',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      },
    );
    SettingsPanel.instance = new SettingsPanel(panel, context, secrets, getCurrent);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private configDebounce: ReturnType<typeof setTimeout> | undefined;
  private sessionSub: vscode.Disposable | undefined;
  private sessionSubTracker: unknown;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly secrets: SecretsManager,
    private readonly getCurrent: CurrentGetter,
  ) {
    panel.webview.html = this.getHtml(panel.webview, context.extensionUri);

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // Reflect external settings.json edits (and our own writes after the reload).
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('orcp')) {
          return;
        }
        if (this.configDebounce) {
          clearTimeout(this.configDebounce);
        }
        this.configDebounce = setTimeout(() => this.postState(), 250);
      }),
    );

    // Reflect API key changes.
    this.disposables.push(
      context.secrets.onDidChange((e) => {
        if (e.key === 'orcp.apiKey') {
          this.postState();
        }
      }),
    );
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          await this.postState();
          return;
        case 'setApiKey':
          await this.secrets.promptAndSave();
          return;
        case 'clearApiKey':
          await this.secrets.deleteApiKey();
          vscode.window.showInformationMessage('ORCP: API key removed.');
          return;
        case 'updateConfig': {
          const key = msg.key as string;
          await vscode.workspace
            .getConfiguration('orcp')
            .update(key, msg.value, vscode.ConfigurationTarget.Global);
          return;
        }
        case 'updateModelConfig': {
          const cfg = vscode.workspace.getConfiguration('orcp');
          const models: Record<string, Record<string, unknown>> = {
            ...(cfg.get('models', {}) as Record<string, Record<string, unknown>>),
          };
          const modelId = msg.modelId as string;
          const patch = (msg.patch ?? {}) as Record<string, unknown>;
          const merged = { ...(models[modelId] ?? {}), ...patch };
          // Drop keys set back to their defaults so the config stays tidy.
          if (merged.enabled === true) {
            delete merged.enabled;
          }
          if (Array.isArray(merged.effortLevels) && merged.effortLevels.length === 0) {
            delete merged.effortLevels;
          }
          if (merged.cacheControl === false) {
            delete merged.cacheControl;
          }
          if (Object.keys(merged).length === 0) {
            delete models[modelId];
          } else {
            models[modelId] = merged;
          }
          await cfg.update('models', models, vscode.ConfigurationTarget.Global);
          return;
        }
        case 'resetSession':
          this.getCurrent()?.tracker.reset();
          return;
        default:
          log.warn(`SettingsPanel: unknown message type ${msg.type}`);
      }
    } catch (err) {
      log.error('SettingsPanel message handling failed:', err);
      vscode.window.showErrorMessage(`ORCP settings: ${String(err)}`);
    }
  }

  // The SessionTracker is recreated on every config-driven re-registration, so
  // rebind the live-session listener to the current one each time we refresh.
  private resubscribeSession(): void {
    const tracker = this.getCurrent()?.tracker;
    if (!tracker || tracker === this.sessionSubTracker) {
      return;
    }
    this.sessionSub?.dispose();
    this.sessionSub = tracker.onDidChange.event((s) => this.post({ type: 'session', session: s }));
    this.sessionSubTracker = tracker;
  }

  private async postState(): Promise<void> {
    this.resubscribeSession();
    const cfg = vscode.workspace.getConfiguration('orcp');
    const current = this.getCurrent();
    const apiKey = await this.secrets.getApiKey();
    this.post({
      type: 'state',
      apiKeySet: !!apiKey,
      baseUrl: cfg.get('baseUrl', 'https://openrouter.ai/api/v1'),
      models: cfg.get('models', {}),
      defaultEffortLevels: cfg.get('defaultEffortLevels', []),
      providerRouting: cfg.get('providerRouting', {}),
      commandSafety: {
        enabled: cfg.get('commandSafety.enabled', true),
        minLevelToShow: cfg.get('commandSafety.minLevelToShow', 'green'),
        aiEvaluation: cfg.get('commandSafety.aiEvaluation', true),
        model: cfg.get('commandSafety.model', ''),
        prompt: cfg.get('commandSafety.prompt', ''),
        allowList: cfg.get('commandSafety.allowList', []),
        denyList: cfg.get('commandSafety.denyList', []),
        modalOnRed: cfg.get('commandSafety.modalOnRed', false),
        redactSecretFiles: cfg.get('commandSafety.redactSecretFiles', true),
        secretFilePatterns: cfg.get('commandSafety.secretFilePatterns', []),
        redactObfuscatedReads: cfg.get('commandSafety.redactObfuscatedReads', false),
      },
      defaultSafetyPrompt: DEFAULT_SAFETY_PROMPT,
      availableModels: current?.listConfigurableModels() ?? [],
      session: current?.tracker.summary ?? {
        turns: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalReasoningTokens: 0,
        totalCostUSD: 0,
      },
    });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'settings.css'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>OpenRouter Settings</title>
</head>
<body>
  <h1>OpenRouter Chat Provider</h1>
  <p class="subtitle">Configure your provider, models, and terminal risk assessment.</p>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    SettingsPanel.instance = undefined;
    if (this.configDebounce) {
      clearTimeout(this.configDebounce);
    }
    this.sessionSub?.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
