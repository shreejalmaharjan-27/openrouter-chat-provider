import vscode from 'vscode';
import { ModelRegistry } from './ModelRegistry';
import { OpenRouterClient } from './OpenRouterClient';
import { SessionTracker } from './SessionTracker';
import { convertMessages, convertTools } from './messageConverter';
import { handleStream } from './streamHandler';
import { log } from './Logger';
import { ModelEntry } from './types';
import type { ChatStreamChunk, ChatToolChoice } from '@openrouter/sdk/models';
import { ChatToolChoiceRequired, ChatToolChoiceAuto } from '@openrouter/sdk/models';

function describeApiError(err: unknown): { msg: string; isAuth: boolean; isPayment: boolean; isRate: boolean } {
  const e = err as { error?: { code?: number; message?: string; metadata?: Record<string, unknown> }; message?: string; statusCode?: number; status?: number; body?: string };
  const apiMessage = e?.error?.message;
  const apiCode = e?.error?.code ?? e?.statusCode ?? e?.status;
  const rawMeta = e?.error?.metadata?.raw;
  const fallback = e?.message ?? String(err);
  const msg = apiMessage
    ? `${apiMessage}${rawMeta ? ` (raw: ${typeof rawMeta === 'string' ? rawMeta : JSON.stringify(rawMeta)})` : ''}`
    : fallback;
  const code = String(apiCode ?? '');
  const fallbackStr = String(fallback);
  const isAuth = code === '401' || fallbackStr.includes('401') || fallbackStr.includes('Unauthorized');
  const isPayment = code === '402' || fallbackStr.includes('402') || fallbackStr.includes('Payment');
  const isRate = code === '429' || fallbackStr.includes('429') || fallbackStr.toLowerCase().includes('rate limit') || fallbackStr.includes('Too Many');
  return { msg, isAuth, isPayment, isRate };
}

function mapToolChoice(toolMode: vscode.LanguageModelChatToolMode | undefined): ChatToolChoice {
  return toolMode === vscode.LanguageModelChatToolMode.Required
    ? ChatToolChoiceRequired.Required
    : ChatToolChoiceAuto.Auto;
}

export class ChatProvider implements vscode.LanguageModelChatProvider<ModelEntry> {
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly client: OpenRouterClient,
    private readonly tracker: SessionTracker,
  ) {
    this.onDidChangeLanguageModelChatInformation = this.registry.onDidChange.event;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<ModelEntry[]> {
    if (options.silent) {
      const key = await this.client.getApiKey();
      if (!key) {
        return [];
      }
    }

    return this.registry.getAll();
  }

  async provideLanguageModelChatResponse(
    model: ModelEntry,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const effort = model.effort;
    const toolChoice = mapToolChoice(options.toolMode);

    const orMessages = convertMessages(messages, {
      useCacheControl: model.cacheControl,
      supportsImageInput: model.capabilities.imageInput === true,
    });
    const orTools = options.tools && options.tools.length > 0
      ? convertTools(options.tools)
      : undefined;

    log.info(`chat request: model=${model.orModelId} effort=${effort ?? 'none'} msgs=${orMessages.length} tools=${orTools?.length ?? 0} cacheControl=${model.cacheControl}`);

    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    let stream: AsyncIterable<ChatStreamChunk>;
    try {
      stream = await this.client.streamChat(model.orModelId, orMessages, {
        effort,
        toolChoice,
        tools: orTools,
      }, abort.signal);
    } catch (err: unknown) {
      log.error('streamChat threw:', err);
      const requestPreview = orMessages.map((m) => ({
        role: (m as { role: string }).role,
        hasReasoning: !!(m as { reasoning?: unknown }).reasoning,
        hasReasoningDetails: !!(m as { reasoningDetails?: unknown }).reasoningDetails,
        contentKind: Array.isArray((m as { content?: unknown }).content)
          ? `array(${((m as { content: unknown[] }).content).length})`
          : typeof (m as { content?: unknown }).content,
      }));
      log.error('outgoing request shape:', requestPreview);
      const { msg, isAuth, isPayment, isRate } = describeApiError(err);
      log.error(`extracted API message: "${msg}"`);
      if (isAuth) {
        throw new Error('ORCP: Invalid API key. Run "ORCP: Set API Key".');
      }
      if (isPayment) {
        throw new Error('ORCP: Insufficient credits. Visit https://openrouter.ai/credits');
      }
      if (isRate) {
        throw new Error('ORCP: Rate limit reached. Please wait a moment.');
      }
      throw new Error(`ORCP: ${msg}`);
    }

    const turnRecord = await handleStream(stream, progress, token);

    this.tracker.addTurn(turnRecord);
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.max(1, Math.ceil(text.length / 4));
    }

    const parts = text.content;
    let totalChars = 0;
    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        totalChars += part.value.length;
      }
    }
    return Math.max(1, Math.ceil(totalChars / 4));
  }
}
