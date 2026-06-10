import vscode from 'vscode';
import { SecretsManager } from './SecretsManager';
import { registerAll } from './registry';
import type { RegistrationResult } from './registry';
import { SettingsPanel } from './SettingsPanel';
import { log } from './Logger';

let current: RegistrationResult | undefined;
let inFlightToken = 0;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const version = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
  log.info(`Activating ORCP extension v${version} (id=${context.extension.id})`);
  const secrets = new SecretsManager(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('orcp.setApiKey', async () => {
      await secrets.promptAndSave();
    }),

    vscode.commands.registerCommand('orcp.clearApiKey', async () => {
      await secrets.deleteApiKey();
      vscode.window.showInformationMessage('OpenRouter: API key removed.');
    }),

    vscode.commands.registerCommand('orcp.reloadExtension', async () => {
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    }),

    vscode.commands.registerCommand('orcp.showSessionDetails', async () => {
      const tracker = current?.tracker;
      if (!tracker) {
        vscode.window.showInformationMessage('ORCP: no active session.');
        return;
      }
      const s = tracker.summary;
      const msg = `Turns: ${s.turns}  ·  Cost: $${s.totalCostUSD.toFixed(4)}\n`
        + `Prompt tokens: ${s.totalPromptTokens.toLocaleString()}  ·  `
        + `Completion: ${s.totalCompletionTokens.toLocaleString()}  ·  `
        + `Reasoning: ${s.totalReasoningTokens.toLocaleString()}`;
      const choice = await vscode.window.showInformationMessage(msg, { modal: false }, 'Reset');
      if (choice === 'Reset') {
        tracker.reset();
      }
    }),

    vscode.commands.registerCommand('orcp.configureEffort', async () => {
      const models = current?.listReasoningModels() ?? [];
      if (models.length === 0) {
        vscode.window.showInformationMessage('ORCP: no reasoning-capable models are registered. Set your API key first.');
        return;
      }

      const pickedModel = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.name, description: m.id, modelId: m.id })),
        { title: 'ORCP: pick a model to configure reasoning effort', matchOnDescription: true },
      );
      if (!pickedModel) return;

      const cfg = vscode.workspace.getConfiguration('orcp');
      const allModels: Record<string, { enabled?: boolean; effortLevels?: string[]; cacheControl?: boolean }>
        = cfg.get('models', {});
      const currentEfforts: string[] = allModels[pickedModel.modelId]?.effortLevels ?? [];

      const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
      const picked = await vscode.window.showQuickPick(
        efforts.map((e) => ({ label: e, picked: currentEfforts.includes(e) })),
        {
          canPickMany: true,
          title: `ORCP: effort variants for ${pickedModel.label} (each becomes a separate entry in the picker)`,
        },
      );
      if (!picked) return;

      const existing = allModels[pickedModel.modelId] ?? { enabled: true };
      existing.effortLevels = picked.map((p) => p.label);
      allModels[pickedModel.modelId] = existing;

      await cfg.update('models', allModels, vscode.ConfigurationTarget.Global);
      const summary = existing.effortLevels.length > 0
        ? existing.effortLevels.join(', ')
        : '(none — only the base entry will appear)';
      vscode.window.showInformationMessage(`ORCP: ${pickedModel.label} effort variants → ${summary}`);
    }),

    vscode.commands.registerCommand('orcp.openSettings', () => {
      SettingsPanel.show(context, secrets, () => current);
    }),
  );

  context.subscriptions.push(
    context.secrets.onDidChange(e => {
      if (e.key === 'orcp.apiKey') {
        doRegister(context, secrets);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('orcp')) {
        doRegister(context, secrets);
      }
    }),
  );

  await doRegister(context, secrets);
}

async function doRegister(
  context: vscode.ExtensionContext,
  secrets: SecretsManager,
): Promise<void> {
  const myToken = ++inFlightToken;
  log.info(`doRegister #${myToken} starting`);
  current?.dispose();
  current = undefined;

  try {
    const result = await registerAll(context, secrets);
    if (myToken !== inFlightToken) {
      log.info(`doRegister #${myToken} superseded by #${inFlightToken}; disposing orphan`);
      result.dispose();
      return;
    }
    current = result;
    log.info(`doRegister #${myToken} complete`);
  } catch (err) {
    log.error('Registration failed:', err);
    vscode.window.showErrorMessage(`ORCP: Failed to initialize. ${String(err)}`);
  }
}

export function deactivate(): void {
  log.info('Deactivating ORCP extension');
  current?.dispose();
  current = undefined;
  log.dispose();
}
