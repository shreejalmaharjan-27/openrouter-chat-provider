import vscode from 'vscode';
import { log } from './Logger';
import { TurnRecord } from './types';
import type {
  ChatStreamChunk,
  ChatStreamDelta,
  ChatUsage,
} from '@openrouter/sdk/models';

interface ToolCallBuffer {
  id: string;
  name: string;
  argsBuffer: string;
}

export async function handleStream(
  stream: AsyncIterable<ChatStreamChunk>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
): Promise<TurnRecord> {
  let generationId = '';
  let orModelId = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let costUSD: number | undefined;

  const toolCallBuffers = new Map<number, ToolCallBuffer>();
  const reasoningByIndex = new Map<number, Record<string, unknown>>();

  function mergeDetail(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of ['text', 'summary', 'data']) {
      const sv = source[key];
      if (typeof sv === 'string') {
        const tv = target[key];
        target[key] = (typeof tv === 'string' ? tv : '') + sv;
      }
    }
    for (const key of ['signature', 'format', 'id', 'type']) {
      if (source[key] !== undefined && source[key] !== null) {
        target[key] = source[key];
      }
    }
  }

  function snapshotDetails(): unknown[] {
    return [...reasoningByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
  }

  for await (const chunk of stream) {
    if (token.isCancellationRequested) {
      break;
    }

    if (!generationId && chunk.id) {
      generationId = chunk.id;
    }

    if (!orModelId && chunk.model) {
      orModelId = chunk.model;
    }

    const choices = chunk.choices;
    if (!choices || choices.length === 0) {
      continue;
    }

    const delta: ChatStreamDelta | undefined = choices[0]?.delta;

    if (!delta) {
      continue;
    }

    const deltaDetails = (delta as { reasoningDetails?: unknown[] }).reasoningDetails;
    const hasNewDetails = Array.isArray(deltaDetails) && deltaDetails.length > 0;
    if (hasNewDetails) {
      for (const d of deltaDetails as unknown[]) {
        const detail = d as Record<string, unknown>;
        const idx = typeof detail.index === 'number' ? detail.index : 0;
        const existing = reasoningByIndex.get(idx);
        if (existing) {
          mergeDetail(existing, detail);
        } else {
          reasoningByIndex.set(idx, { ...detail });
        }
      }
    }

    if (delta.reasoning || hasNewDetails) {
      const hasThinkingPart = 'LanguageModelThinkingPart' in vscode;
      if (hasThinkingPart) {
        const thinkingPart = new vscode.LanguageModelThinkingPart(
          delta.reasoning ?? '',
          undefined,
          { reasoningDetails: snapshotDetails() },
        );
        progress.report(thinkingPart as vscode.LanguageModelResponsePart);
      }
    }

    if (delta.content) {
      const textPart = new vscode.LanguageModelTextPart(delta.content);
      progress.report(textPart);
    }

    if (delta.toolCalls) {
      for (const tc of delta.toolCalls) {
        const index = tc.index;
        let buffer = toolCallBuffers.get(index);

        if (!buffer) {
          buffer = {
            id: tc.id || '',
            name: tc.function?.name || '',
            argsBuffer: '',
          };
          toolCallBuffers.set(index, buffer);
        }

        if (tc.id && !buffer.id) {
          buffer.id = tc.id;
        }

        if (tc.function?.name && !buffer.name) {
          buffer.name = tc.function.name;
        }

        if (tc.function?.arguments) {
          buffer.argsBuffer += tc.function.arguments;
        }
      }
    }

    if (chunk.usage) {
      const usage: ChatUsage = chunk.usage;
      promptTokens = usage.promptTokens ?? 0;
      completionTokens = usage.completionTokens ?? 0;
      reasoningTokens = usage.completionTokensDetails?.reasoningTokens ?? 0;
      if (usage.cost !== undefined && usage.cost !== null) {
        costUSD = usage.cost;
      }
    }
  }

  for (const [, buffer] of toolCallBuffers) {
    let parsedArgs: object = {};
    try {
      if (buffer.argsBuffer) {
        parsedArgs = JSON.parse(buffer.argsBuffer);
      }
    } catch {
      parsedArgs = {};
    }

    const toolCallPart = new vscode.LanguageModelToolCallPart(buffer.id, buffer.name, parsedArgs);
    progress.report(toolCallPart);
  }

  const finalDetails = snapshotDetails();
  log.info(`stream complete: gen=${generationId} model=${orModelId} prompt=${promptTokens} completion=${completionTokens} reasoning=${reasoningTokens} mergedReasoningDetails=${finalDetails.length}`);

  return {
    generationId,
    orModelId,
    promptTokens,
    completionTokens,
    reasoningTokens,
    costUSD,
  };
}
