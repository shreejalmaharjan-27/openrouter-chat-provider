import vscode from 'vscode';
import { ModelRegistry } from './ModelRegistry';
import { OpenRouterClient } from './OpenRouterClient';
import { SessionTracker } from './SessionTracker';
import { convertMessages, convertTools } from './messageConverter';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { handleStream, SafetyOptions } from './streamHandler';
import { assessLocal, listMatch, commandReferencesSecret, fileMatchesSecret, extractPathTokens, assessExfiltration, bodyTouchesSecret, isObfuscatedCommand, extractScriptRefs, decodeBase64Candidates, DEFAULT_SAFETY_PROMPT, DEFAULT_SECRET_PATTERNS, RISK_RANK, Risk, Verdict } from './commandSafety';
import { log } from './Logger';
import { ModelEntry } from './types';
import type { ChatStreamChunk, ChatToolChoice, ChatMessages } from '@openrouter/sdk/models';
import { ChatToolChoiceRequired, ChatToolChoiceAuto } from '@openrouter/sdk/models';

const SAFETY_TIMEOUT_MS = 6000;
const SCRIPT_READ_MAX_BYTES = 200_000;
const SCRIPT_CONTEXT_PER_FILE = 8000;
const SCRIPT_CONTEXT_TOTAL = 16000;
const SCRIPT_MAX_FILES = 4;

interface CommandSafetyConfig {
  useAi: boolean;
  model: string;
  prompt: string;
  allowList: string[];
  denyList: string[];
  redactSecrets: boolean;
  redactObfuscatedReads: boolean;
  secretPatterns: string[];
}

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

function pickArg(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) {
    return undefined;
  }
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

function normalizeRisk(value: unknown): Risk | undefined {
  if (value === 'green' || value === 'orange' || value === 'red') {
    return value;
  }
  if (value === 'yellow') {
    return 'orange';
  }
  return undefined;
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
    const orModelId = model.orModelId;
    const effort = model.effort;
    const toolChoice = mapToolChoice(options.toolMode);

    const cfg = vscode.workspace.getConfiguration('orcp');
    const redactSecrets = cfg.get<boolean>('commandSafety.redactSecretFiles', true);
    const redactObfuscated = cfg.get<boolean>('commandSafety.redactObfuscatedReads', false);
    const secretPatterns = redactSecrets
      ? [...DEFAULT_SECRET_PATTERNS, ...(cfg.get<string[]>('commandSafety.secretFilePatterns', []) ?? [])]
      : [];
    const anyRedaction = redactSecrets || redactObfuscated;

    const orMessages = convertMessages(messages, {
      useCacheControl: model.cacheControl,
      supportsImageInput: model.capabilities.imageInput === true,
      redactSecrets: anyRedaction,
      secretPatterns,
      secretCallIds: anyRedaction ? this.computeSecretToolCallIds(messages, secretPatterns, redactObfuscated) : undefined,
    });
    const orTools = options.tools && options.tools.length > 0
      ? convertTools(options.tools)
      : undefined;

    log.info(`chat request: model=${orModelId} effort=${effort ?? 'none'} msgs=${orMessages.length} tools=${orTools?.length ?? 0} cacheControl=${model.cacheControl}`);

    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    let stream: AsyncIterable<ChatStreamChunk>;
    try {
      stream = await this.client.streamChat(orModelId, orMessages, {
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

    const turnRecord = await handleStream(stream, progress, token, this.buildSafetyOptions());

    this.tracker.addTurn(turnRecord);
  }

  private buildSafetyOptions(): SafetyOptions | undefined {
    const cfg = vscode.workspace.getConfiguration('orcp');
    if (cfg.get<boolean>('commandSafety.enabled', true) === false) {
      return undefined;
    }
    const minLevel = (cfg.get<string>('commandSafety.minLevelToShow', 'green') as Risk);
    const modalOnRed = cfg.get<boolean>('commandSafety.modalOnRed', false);
    const safety: CommandSafetyConfig = {
      useAi: cfg.get<boolean>('commandSafety.aiEvaluation', true),
      model: (cfg.get<string>('commandSafety.model', '') ?? '').trim(),
      prompt: (cfg.get<string>('commandSafety.prompt', '') ?? '').trim() || DEFAULT_SAFETY_PROMPT,
      allowList: cfg.get<string[]>('commandSafety.allowList', []) ?? [],
      denyList: cfg.get<string[]>('commandSafety.denyList', []) ?? [],
      redactSecrets: cfg.get<boolean>('commandSafety.redactSecretFiles', true),
      redactObfuscatedReads: cfg.get<boolean>('commandSafety.redactObfuscatedReads', false),
      secretPatterns: [...DEFAULT_SECRET_PATTERNS, ...(cfg.get<string[]>('commandSafety.secretFilePatterns', []) ?? [])],
    };

    return {
      minLevel,
      modalOnRed,
      assess: (command: string, writtenFiles: Map<string, string>) => this.assessCommand(command, safety, writtenFiles),
    };
  }

  private async assessCommand(command: string, safety: CommandSafetyConfig, writtenFiles: Map<string, string>): Promise<Verdict> {
    // User lists win and skip the model entirely. Deny takes precedence over allow.
    if (listMatch(command, safety.denyList)) {
      return { risk: 'red', reason: 'Matches your command blocklist.' };
    }
    if (listMatch(command, safety.allowList)) {
      return { risk: 'green', reason: 'Matches your command allowlist.' };
    }

    // Accessing a secret file is always critical — decided deterministically so the
    // model can never downgrade it (covers custom patterns and symlinks to secrets).
    if (commandReferencesSecret(command, safety.secretPatterns) || this.resolvesToSecret(command, safety.secretPatterns)) {
      const note = safety.redactSecrets ? ' — its contents are withheld from the model' : '';
      return { risk: 'red', reason: `Accesses a secret file (.env / key / credentials)${note}.` };
    }

    // Secret exfiltration in the command itself (network egress + secret/env).
    const cmdExfil = assessExfiltration(command, safety.secretPatterns);
    if (cmdExfil) {
      return cmdExfil;
    }

    // If the command runs a script/file, read it so its actual behavior (incl.
    // obfuscated payloads, secret reads, and exfiltration) is judged — not just
    // the innocent-looking command line.
    const scriptContext = this.gatherScriptContext(command, writtenFiles);
    if (scriptContext) {
      const scriptVerdict = bodyTouchesSecret(scriptContext, safety.secretPatterns);
      if (scriptVerdict) {
        return scriptVerdict;
      }
    }

    // Opt-in: a command/script obfuscated enough that we can't resolve what it
    // touches is treated as critical and its output is withheld upstream.
    if (safety.redactObfuscatedReads && (isObfuscatedCommand(command) || (scriptContext !== undefined && isObfuscatedCommand(scriptContext)))) {
      return { risk: 'red', reason: 'Obfuscated/encoded command — its target can’t be verified, so its output is withheld from the model.' };
    }

    // By default every command is evaluated by the model; local rules are the
    // fallback when AI is off, no model is set, or the call fails/times out.
    if (safety.useAi && safety.model) {
      try {
        const modelVerdict = await this.classifyWithModel(command, safety.model, safety.prompt, scriptContext);
        if (modelVerdict) {
          return modelVerdict;
        }
      } catch (err) {
        log.warn('command-safety model evaluation failed; using local rules:', err);
      }
    }

    // Local fallback: worst of the command itself and any executed script body.
    let verdict = assessLocal(command).verdict;
    if (scriptContext) {
      const scriptVerdict = assessLocal(scriptContext).verdict;
      if (RISK_RANK[scriptVerdict.risk] > RISK_RANK[verdict.risk]) {
        verdict = { risk: scriptVerdict.risk, reason: `Executed script: ${scriptVerdict.reason}` };
      }
    }
    return verdict;
  }

  // Resolve and read the script files a command executes. Prefers files written
  // this turn (in `writtenFiles`); otherwise reads from disk relative to the
  // workspace / any `cd` directory. Returns a capped, labelled blob or undefined.
  private gatherScriptContext(command: string, writtenFiles: Map<string, string>): string | undefined {
    const { dirs, files } = extractScriptRefs(command);
    if (files.length === 0) {
      return undefined;
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const baseDirs = [
      ...dirs.flatMap((d) => (isAbsolute(d) ? [d] : roots.map((r) => join(r, d)))),
      ...roots,
    ];

    const chunks: string[] = [];
    const readLog: string[] = [];
    let total = 0;
    for (const ref of files.slice(0, SCRIPT_MAX_FILES)) {
      const hit = this.readScriptFile(ref, baseDirs, writtenFiles);
      if (hit === undefined) {
        readLog.push(`${ref}=not-found`);
        continue;
      }
      const capped = hit.content.slice(0, SCRIPT_CONTEXT_PER_FILE);
      chunks.push(`--- ${ref} ---\n${capped}`);
      total += capped.length;
      readLog.push(`${ref}=${hit.source}:${capped.length}b`);
      if (total >= SCRIPT_CONTEXT_TOTAL) {
        break;
      }
    }
    log.info(`command-safety: script refs ${JSON.stringify(files)} → ${readLog.join(', ') || 'none'}`);
    return chunks.length > 0 ? chunks.join('\n\n') : undefined;
  }

  // Tool-call ids whose RESULT must be redacted: file reads of a secret path
  // (incl. symlinks), terminal commands that reference a secret, and terminal
  // commands that run a script which reads a secret (so printed secrets are
  // withheld too). ChatProvider does this — it has filesystem + script access.
  private computeSecretToolCallIds(messages: readonly vscode.LanguageModelChatRequestMessage[], patterns: string[], redactObfuscated: boolean): Set<string> {
    const ids = new Set<string>();
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        continue;
      }
      for (const part of msg.content) {
        if (!(part instanceof vscode.LanguageModelToolCallPart) || !part.callId) {
          continue;
        }
        const input = part.input as Record<string, unknown> | undefined;
        const path = pickArg(input, ['filePath', 'path', 'file', 'uri', 'fileName', 'absolutePath', 'targetFile']);
        const cmd = pickArg(input, ['command', 'commandLine', 'cmd']);
        let taint = false;
        if (path && patterns.length > 0 && (fileMatchesSecret(path, patterns) || this.resolvesToSecret(path, patterns))) {
          taint = true;
        }
        if (!taint && cmd) {
          if (patterns.length > 0 && (commandReferencesSecret(cmd, patterns) || this.resolvesToSecret(cmd, patterns))) {
            taint = true;
          } else {
            const sc = this.gatherScriptContext(cmd, new Map());
            if (sc && patterns.length > 0 && commandReferencesSecret(sc, patterns)) {
              taint = true;
            } else if (redactObfuscated && (isObfuscatedCommand(cmd) || (sc !== undefined && isObfuscatedCommand(sc)))) {
              taint = true;
            }
          }
        }
        if (taint) {
          ids.add(part.callId);
        }
      }
    }
    return ids;
  }

  // Resolve path tokens (incl. symlinks) and check whether any points at a secret
  // file. Closes the `ln -s ~/.env /tmp/x && cat /tmp/x` evasion.
  private resolvesToSecret(command: string, patterns: string[]): boolean {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    for (const token of extractPathTokens(command)) {
      const expanded = token.startsWith('~/') ? join(homedir(), token.slice(2)) : token;
      const candidates = isAbsolute(expanded) ? [expanded] : [expanded, ...roots.map((r) => join(r, expanded))];
      for (const candidate of candidates) {
        try {
          const real = realpathSync(candidate);
          if (fileMatchesSecret(real, patterns)) {
            return true;
          }
        } catch {
          // path doesn't exist / not resolvable — ignore
        }
      }
    }
    return false;
  }

  private readScriptFile(ref: string, baseDirs: string[], writtenFiles: Map<string, string>): { content: string; source: string } | undefined {
    // 1. A file the agent wrote this turn (may not be on disk yet).
    for (const [p, c] of writtenFiles) {
      if (p === ref || basename(p) === basename(ref) || p.endsWith(ref) || ref.endsWith(p)) {
        return { content: c, source: 'written-this-turn' };
      }
    }
    // 2. On disk.
    const expanded = ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : ref;
    const candidates = isAbsolute(expanded) ? [expanded] : baseDirs.map((b) => join(b, expanded));
    for (const candidate of candidates) {
      try {
        const st = statSync(candidate);
        if (st.isFile() && st.size <= SCRIPT_READ_MAX_BYTES) {
          return { content: readFileSync(candidate, 'utf8'), source: 'disk' };
        }
      } catch {
        // not here; try next
      }
    }
    return undefined;
  }

  private async classifyWithModel(command: string, modelId: string, instruction: string, scriptContext?: string): Promise<Verdict | undefined> {
    const orModelId = this.registry.get(modelId)?.orModelId ?? modelId.split('::')[0];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SAFETY_TIMEOUT_MS);
    try {
      const scriptBlock = scriptContext
        ? `\n\nThe command executes the following local file(s). Judge based on what they actually do, including obfuscated/encoded execution:\n${scriptContext}`
        : '';
      const decoded = decodeBase64Candidates(command);
      const decodedBlock = decoded.length > 0
        ? `\n\nThe command contains base64 that decodes to (judge the DECODED intent):\n${decoded.map((d) => `\`\`\`\n${d.slice(0, 800)}\n\`\`\``).join('\n')}`
        : '';
      const prompt = `${instruction}\n\nCommand:\n\`\`\`\n${command}\n\`\`\`${scriptBlock}${decodedBlock}`;
      const messages: ChatMessages[] = [{ role: 'user', content: prompt }];
      const stream = await this.client.streamChat(
        orModelId,
        messages,
        { effort: null, toolChoice: ChatToolChoiceAuto.Auto, maxTokens: 200 },
        abort.signal,
      );
      let text = '';
      for await (const chunk of stream as AsyncIterable<ChatStreamChunk>) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          text += content;
        }
      }
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        return undefined;
      }
      const parsed = JSON.parse(match[0]) as { risk?: unknown; reason?: unknown };
      const risk = normalizeRisk(parsed.risk);
      if (!risk) {
        return undefined;
      }
      const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : 'Assessed by model.';
      log.info(`command-safety model verdict: ${risk} for "${command.slice(0, 80)}"`);
      return { risk, reason };
    } finally {
      clearTimeout(timer);
    }
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
