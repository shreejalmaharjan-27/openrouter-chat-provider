import type * as vscode from 'vscode';
import type { ReasoningEffort } from '@openrouter/sdk/models';

export type { ReasoningEffort } from '@openrouter/sdk/models';

export interface ModelEntry extends vscode.LanguageModelChatInformation {
  readonly orModelId: string;
  readonly effort: ReasoningEffort | null;
  readonly cacheControl: boolean;
  readonly supportsReasoning: boolean;
}

export interface ModelConfig {
  enabled: boolean;
  effortLevels: ReasoningEffort[];
  cacheControl?: boolean;
}

export interface ConfigurableModel {
  id: string;
  name: string;
  supportsReasoning: boolean;
}

export interface TurnRecord {
  generationId: string;
  orModelId: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUSD?: number;
}

export interface SessionSummary {
  turns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  totalCostUSD: number;
}
