import { SecretsManager } from './SecretsManager';
import { ReasoningEffort } from './types';
import { log } from './Logger';
import type { OpenRouter } from '@openrouter/sdk';
import type {
  Model,
  ChatMessages,
  ChatFunctionTool,
  ChatToolChoice,
  ReasoningConfig,
  ChatStreamChunk,
  ChatRequest,
} from '@openrouter/sdk/models';

const HTTP_REFERER = 'https://github.com/ostash/openrouter-chat-provider';
const APP_TITLE = 'OpenRouter Chat Provider for VSCode';
const APP_CATEGORIES = 'ide-extension';

export class OpenRouterClient {
  private sdkClient: OpenRouter | null = null;
  private cachedApiKey: string | null = null;
  private cachedBaseUrl: string | null = null;

  constructor(
    private readonly secrets: SecretsManager,
    private readonly baseUrl: string,
    private readonly providerRouting: Record<string, unknown> = {},
  ) {}

  private async getClient(): Promise<OpenRouter> {
    const apiKey = await this.secrets.getApiKey();
    if (!apiKey) {
      this.sdkClient = null;
      this.cachedApiKey = null;
      throw new Error('OpenRouter API key is not set. Use ORCP: Set API Key command.');
    }

    // Reset client if API key or base URL has changed
    if (this.sdkClient && (this.cachedApiKey !== apiKey || this.cachedBaseUrl !== this.baseUrl)) {
      this.sdkClient = null;
    }

    if (this.sdkClient) {
      return this.sdkClient;
    }

    const { OpenRouter, HTTPClient } = await import('@openrouter/sdk');
    const httpClient = new HTTPClient();
    httpClient.addHook('beforeRequest', async (req) => {
      if (!/\/chat\/completions(\?|$)/.test(req.url)) {
        return req;
      }
      try {
        const bodyText = await req.clone().text();
        if (!bodyText) {
          return req;
        }
        const body = JSON.parse(bodyText) as {
          messages?: Array<Record<string, unknown>>;
          reasoning?: Record<string, unknown>;
        };

        // The SDK's outbound schema drops `enabled`, so explicitly turn reasoning
        // on here (matching OpenRouter's expected `{ enabled: true, effort }` shape)
        // whenever an effort is set.
        let reasoningEnabled = false;
        if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort) {
          body.reasoning.enabled = true;
          reasoningEnabled = true;
        }
        log.info(`beforeRequest: reasoning=${body.reasoning ? JSON.stringify(body.reasoning) : 'none'}`);

        let patched = 0;
        if (Array.isArray(body.messages)) {
          for (const msg of body.messages) {
            if (
              msg.role === 'assistant' &&
              typeof msg.reasoning === 'string' &&
              msg.reasoning.length > 0 &&
              typeof msg.reasoning_content !== 'string'
            ) {
              msg.reasoning_content = msg.reasoning;
              patched++;
            }
          }
        }
        if (patched === 0 && !reasoningEnabled) {
          return req;
        }
        if (patched > 0) {
          log.debug(`beforeRequest: patched reasoning_content on ${patched} assistant message(s)`);
        }
        return new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify(body),
          redirect: req.redirect,
          referrer: req.referrer,
          referrerPolicy: req.referrerPolicy,
          mode: req.mode,
          credentials: req.credentials,
          cache: req.cache,
          integrity: req.integrity,
          keepalive: req.keepalive,
          signal: req.signal,
        });
      } catch (err) {
        log.warn('beforeRequest hook failed; sending original request:', err);
        return req;
      }
    });

    this.sdkClient = new OpenRouter({
      apiKey,
      httpReferer: HTTP_REFERER,
      appTitle: APP_TITLE,
      appCategories: APP_CATEGORIES,
      serverURL: this.baseUrl,
      httpClient,
    });
    this.cachedApiKey = apiKey;
    this.cachedBaseUrl = this.baseUrl;
    return this.sdkClient;
  }

  resetClient(): void {
    this.sdkClient = null;
    this.cachedApiKey = null;
  }

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.getApiKey();
  }

  async listModels(): Promise<Model[]> {
    const client = await this.getClient();
    const response = await client.models.list();
    return response.data;
  }

  async streamChat(
    orModelId: string,
    messages: ChatMessages[],
    opts: {
      effort: ReasoningConfig['effort'];
      toolChoice: ChatToolChoice;
      tools?: ChatFunctionTool[];
      maxTokens?: number;
    },
    signal: AbortSignal,
  ): Promise<AsyncIterable<ChatStreamChunk>> {
    const client = await this.getClient();

    const chatRequest: ChatRequest = {
      model: orModelId,
      messages,
      stream: true,
      streamOptions: { includeUsage: true },
    };

    if (Object.keys(this.providerRouting).length > 0) {
      (chatRequest as unknown as { provider: Record<string, unknown> }).provider = this.providerRouting;
    }

    if (opts.effort) {
      chatRequest.reasoning = { effort: opts.effort };
    }

    if (opts.toolChoice) {
      chatRequest.toolChoice = opts.toolChoice;
    }

    if (opts.tools?.length) {
      chatRequest.tools = opts.tools;
    }

    if (opts.maxTokens) {
      chatRequest.maxTokens = opts.maxTokens;
    }

    const response = await client.chat.send(
      { chatRequest },
      { signal },
    );

    return response as AsyncIterable<ChatStreamChunk>;
  }
}
