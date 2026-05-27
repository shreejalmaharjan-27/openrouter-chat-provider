import vscode from 'vscode';
import { SecretsManager } from './SecretsManager';
import { registerAll } from './registry';
import type { RegistrationResult } from './registry';
import { log } from './Logger';

let current: RegistrationResult | undefined;
let inFlightToken = 0;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('Activating ORCP extension');
  const secrets = new SecretsManager(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('orcp.setApiKey', async () => {
      await secrets.promptAndSave();
    }),

    vscode.commands.registerCommand('orcp.clearApiKey', async () => {
      await secrets.deleteApiKey();
      vscode.window.showInformationMessage('OpenRouter: API key removed.');
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
