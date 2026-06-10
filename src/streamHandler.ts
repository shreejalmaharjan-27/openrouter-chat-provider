import vscode from 'vscode';
import { log } from './Logger';
import { TurnRecord } from './types';
import { Risk, Verdict, RISK_RANK, isTerminalTool, renderVerdict } from './commandSafety';
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

export interface SafetyOptions {
  minLevel: Risk;
  modalOnRed: boolean;
  assess: (command: string, writtenFiles: Map<string, string>) => Promise<Verdict>;
}

function extractCommand(args: object): string | undefined {
  const cmd = (args as { command?: unknown }).command;
  return typeof cmd === 'string' && cmd.trim() ? cmd : undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

// Generic, tool-name-agnostic detection of a file write: any tool call whose
// arguments carry both a path-like field and a content-like field. Captures
// files the agent creates in the SAME turn so we can inspect them before a
// later terminal command runs them.
function extractWrittenFile(args: object): { path: string; content: string } | undefined {
  const a = args as Record<string, unknown>;
  const path = firstString(a, ['filePath', 'path', 'file', 'uri', 'fileName', 'absolutePath', 'targetFile']);
  const content = firstString(a, ['content', 'code', 'contents', 'newText', 'text', 'newContent', 'fileContent']);
  return path && content ? { path, content } : undefined;
}

export async function handleStream(
  stream: AsyncIterable<ChatStreamChunk>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  safety?: SafetyOptions,
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

  // Parse every tool call's args once, and collect files written this turn so the
  // safety assessor can inspect scripts a terminal command later executes.
  const parsedCalls: Array<{ buffer: ToolCallBuffer; args: object }> = [];
  const writtenFiles = new Map<string, string>();
  for (const [, buffer] of toolCallBuffers) {
    let parsedArgs: object = {};
    try {
      if (buffer.argsBuffer) {
        parsedArgs = JSON.parse(buffer.argsBuffer);
      }
    } catch {
      parsedArgs = {};
    }
    parsedCalls.push({ buffer, args: parsedArgs });
    const written = extractWrittenFile(parsedArgs);
    if (written) {
      writtenFiles.set(written.path, written.content);
    }
  }
  if (safety && writtenFiles.size > 0) {
    log.info(`command-safety: files written this turn: ${JSON.stringify([...writtenFiles.keys()])}`);
  }

  for (const { buffer, args: parsedArgs } of parsedCalls) {
    // Emit an advisory safety verdict immediately above terminal-command cards.
    if (safety && isTerminalTool(buffer.name)) {
      const command = extractCommand(parsedArgs);
      if (command) {
        try {
          const verdict = await safety.assess(command, writtenFiles);
          if (RISK_RANK[verdict.risk] >= RISK_RANK[safety.minLevel]) {
            progress.report(new vscode.LanguageModelTextPart(renderVerdict(verdict)));
          }
          if (verdict.risk === 'red' && safety.modalOnRed) {
            void vscode.window.showWarningMessage(
              `Unsafe command: ${command}\n\n${verdict.reason}`,
              { modal: true },
              'OK',
            );
          }
        } catch (err) {
          log.warn('command-safety assessment failed; forwarding tool call unannotated:', err);
        }
      }
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
