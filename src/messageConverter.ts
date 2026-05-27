import { Buffer } from 'node:buffer';
import vscode from 'vscode';
import { log } from './Logger';
import type {
  ChatAssistantMessage,
  ChatContentItems,
  ChatFunctionTool,
  ChatMessages,
  ChatToolCall,
  ChatToolMessage,
  ChatUserMessage,
} from '@openrouter/sdk/models';

export interface ConvertOptions {
  useCacheControl: boolean;
  supportsImageInput: boolean;
}

function isKnownInputPart(part: unknown): part is vscode.LanguageModelInputPart {
  return part instanceof vscode.LanguageModelTextPart
    || part instanceof vscode.LanguageModelThinkingPart
    || part instanceof vscode.LanguageModelToolCallPart
    || part instanceof vscode.LanguageModelToolResultPart;
}

function isDataPart(part: unknown): boolean {
  const DataPartCtor = (vscode as unknown as { LanguageModelDataPart?: new (...args: unknown[]) => unknown }).LanguageModelDataPart;
  return typeof DataPartCtor === 'function' && part instanceof DataPartCtor;
}

function tagLastTextItemForCache(msg: ChatMessages): void {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (let j = content.length - 1; j >= 0; j--) {
    const item = content[j] as { type?: string; cacheControl?: unknown };
    if (item && item.type === 'text') {
      item.cacheControl = { type: 'ephemeral' };
      return;
    }
  }
}

function extractReasoningDetails(part: vscode.LanguageModelThinkingPart): unknown[] | undefined {
  const meta = (part as unknown as { metadata?: Record<string, unknown> }).metadata;
  const details = meta?.reasoningDetails;
  return Array.isArray(details) && details.length > 0 ? details : undefined;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  opts: ConvertOptions = { useCacheControl: false, supportsImageInput: false },
): ChatMessages[] {
  const result: ChatMessages[] = [];

  for (const msg of messages) {
    const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';

    if (!Array.isArray(msg.content)) {
      console.warn('[ORCP] Message content is not an array, skipping');
      continue;
    }

    let content: ChatContentItems[] = [];
    let reasoning: string | undefined;
    let reasoningDetails: unknown[] | undefined;
    const toolCalls: ChatToolCall[] = [];
    let toolResultContent: string | undefined;
    let toolResultCallId: string | undefined;

    for (const part of msg.content) {
      if (opts.supportsImageInput && isDataPart(part)) {
        const dataPart = part as { mimeType: string; data: Uint8Array };
        const base64 = Buffer.from(dataPart.data).toString('base64');
        content.push({
          type: 'image_url',
          image_url: { url: `data:${dataPart.mimeType};base64,${base64}` },
        } as unknown as ChatContentItems);
        continue;
      }

      if (!isKnownInputPart(part)) {
        continue;
      }

      if (part instanceof vscode.LanguageModelTextPart) {
        content.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        const reasoningValue = typeof part.value === 'string' ? part.value : part.value.join('');
        if (role === 'assistant') {
          reasoning = (reasoning ?? '') + reasoningValue;
          const partDetails = extractReasoningDetails(part);
          if (partDetails) {
            reasoningDetails = partDetails;
          }
        } else {
          console.warn('[ORCP] Thinking part found in non-assistant message, ignoring');
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        if (!part.callId || !part.name) {
          console.warn('[ORCP] Invalid tool call part, missing callId or name');
          continue;
        }
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (!part.callId) {
          console.warn('[ORCP] Tool result part missing callId, ignoring');
          continue;
        }
        toolResultCallId = part.callId;
        const textParts = part.content.filter(
          (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart,
        );
        toolResultContent = textParts.map((p) => p.value).join('\n');
      }
    }

    if (toolResultContent !== undefined && toolResultCallId !== undefined) {
      const toolMessage: ChatToolMessage = {
        role: 'tool',
        content: toolResultContent,
        toolCallId: toolResultCallId,
      };
      result.push(toolMessage);
    } else if (toolCalls.length > 0) {
      const assistantMessage: ChatAssistantMessage = {
        role: 'assistant',
        content: content.length > 0 ? content : undefined,
        reasoning,
        reasoningDetails: reasoningDetails as ChatAssistantMessage['reasoningDetails'],
        toolCalls,
      };
      result.push(assistantMessage);
    } else if (content.length > 0 || reasoning || reasoningDetails) {
      const message: ChatUserMessage | ChatAssistantMessage = role === 'user'
        ? { role: 'user', content: content.length > 0 ? content : '' }
        : {
          role: 'assistant',
          content: content.length > 0 ? content : undefined,
          reasoning,
          reasoningDetails: reasoningDetails as ChatAssistantMessage['reasoningDetails'],
        };
      result.push(message);
    } else {
      console.warn(`[ORCP] Message has no content, reasoning, or tool calls, skipping`);
    }
  }

  if (opts.useCacheControl) {
    const firstUser = result.find((m) => m.role === 'user');
    if (firstUser) {
      tagLastTextItemForCache(firstUser);
    }
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'assistant') {
        tagLastTextItemForCache(result[i]);
        break;
      }
    }
  }

  return result;
}

function normalizeToolSchema(toolName: string, schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    log.warn(`tool "${toolName}" has no/invalid schema; substituting empty object schema`);
    return { type: 'object', properties: {} };
  }
  const s = schema as Record<string, unknown>;
  if (s.type === undefined || s.type === null || s.type === 'null') {
    log.warn(`tool "${toolName}" has type=${JSON.stringify(s.type)}; coercing to "object"`);
    return { ...s, type: 'object', properties: (s.properties as Record<string, unknown>) ?? {} };
  }
  return s;
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[],
): ChatFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolSchema(tool.name, tool.inputSchema),
    },
  }));
}
