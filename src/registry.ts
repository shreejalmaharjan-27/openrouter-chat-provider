import vscode from 'vscode';
import { SecretsManager } from './SecretsManager';
import { OpenRouterClient } from './OpenRouterClient';
import { ModelRegistry } from './ModelRegistry';
import { SessionTracker } from './SessionTracker';
import { ChatProvider } from './ChatProvider';
import { CostStatusBar } from './CostStatusBar';
import { log } from './Logger';
import { ModelConfig, ReasoningEffort } from './types';

export interface RegistrationResult extends vscode.Disposable {
  readonly tracker: SessionTracker;
}

export async function registerAll(
  context: vscode.ExtensionContext,
  secrets: SecretsManager,
): Promise<RegistrationResult> {
  const cfg = vscode.workspace.getConfiguration('orcp');
  const baseUrl: string = cfg.get('baseUrl', 'https://openrouter.ai/api/v1');
  const modelConfigs: Record<string, ModelConfig> = cfg.get('models', {});
  const defaultEffortLevels: ReasoningEffort[] = cfg.get('defaultEffortLevels', []);
  const providerRouting: Record<string, unknown> = cfg.get('providerRouting', {});

  log.info(`registerAll: baseUrl=${baseUrl}, models configured=${Object.keys(modelConfigs).length}, defaultEffortLevels=${JSON.stringify(defaultEffortLevels)}, providerRouting=${JSON.stringify(providerRouting)}`);

  const client = new OpenRouterClient(secrets, baseUrl, providerRouting);
  const registry = new ModelRegistry();
  const tracker = new SessionTracker();
  const statusBar = new CostStatusBar(tracker);
  const provider = new ChatProvider(registry, client, tracker);

  try {
    const rawModels = await client.listModels();
    log.info(`fetched ${rawModels.length} models from OpenRouter`);
    registry.rebuild(rawModels, modelConfigs, defaultEffortLevels);
    const allEntries = registry.getAll();
    log.info(`registered ${allEntries.length} model entries (after filters + effort variants)`);
    log.debug('model ids:', allEntries.map((e) => e.id));
  } catch (err) {
    log.error('listModels failed:', err);
    if (err instanceof Error && err.message.includes('API key')) {
      const choice = await vscode.window.showErrorMessage(
        'ORCP: No API key configured. Models will not appear in the picker.',
        'Set API Key',
      );
      if (choice === 'Set API Key') {
        await secrets.promptAndSave();
      }
    } else {
      vscode.window.showErrorMessage(`ORCP: Failed to load models. ${String(err)}`);
    }
  }

  const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
    'ostash.openrouter',
    provider,
  );

  return {
    tracker,
    dispose() {
      providerDisposable.dispose();
      registry.dispose();
      tracker.dispose();
      statusBar.dispose();
    },
  };
}
