// Settings page webview script. Vanilla TS, no framework. Communicates with the
// extension host via postMessage. The actual API key value never lives here —
// "Set key" delegates to the extension's native secure input box.

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const SORTS = ['price', 'throughput', 'latency'] as const;

interface ConfigurableModel {
  id: string;
  name: string;
  supportsReasoning: boolean;
}
interface ModelCfg {
  enabled?: boolean;
  effortLevels?: string[];
  cacheControl?: boolean;
}
interface ProviderRouting {
  sort?: string;
  order?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
}
interface SessionSummary {
  turns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  totalCostUSD: number;
}
interface CommandSafety {
  enabled: boolean;
  minLevelToShow: string;
  aiEvaluation: boolean;
  model: string;
  prompt: string;
  allowList: string[];
  denyList: string[];
  modalOnRed: boolean;
  redactSecretFiles: boolean;
  secretFilePatterns: string[];
  redactObfuscatedReads: boolean;
}
interface State {
  apiKeySet: boolean;
  baseUrl: string;
  models: Record<string, ModelCfg>;
  defaultEffortLevels: string[];
  providerRouting: ProviderRouting;
  commandSafety: CommandSafety;
  defaultSafetyPrompt: string;
  availableModels: ConfigurableModel[];
  session: SessionSummary;
}

let state: State | null = null;
let searchQuery = '';
let showAllRiskModels = false;

// --- tiny DOM helpers ---------------------------------------------------------

type Attrs = Record<string, string | number | boolean | EventListener>;

function h(tag: string, attrs: Attrs = {}, children: Array<Node | string> = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (typeof v === 'boolean') {
      if (v) {
        el.setAttribute(k, '');
      }
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function post(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

function updateConfig(key: string, value: unknown): void {
  post({ type: 'updateConfig', key, value });
}

function updateModelConfig(modelId: string, patch: ModelCfg): void {
  post({ type: 'updateModelConfig', modelId, patch });
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// --- sections -----------------------------------------------------------------

function apiKeySection(s: State): HTMLElement {
  const status = s.apiKeySet
    ? h('span', { class: 'status-ok' }, ['● API key is set'])
    : h('span', { class: 'status-warn' }, ['● No API key set']);
  const clearBtn = h('button', {
    class: 'secondary',
    onclick: () => post({ type: 'clearApiKey' }),
  }, ['Clear']);
  if (!s.apiKeySet) {
    (clearBtn as HTMLButtonElement).disabled = true;
  }
  return h('section', {}, [
    h('h2', {}, ['API Key']),
    h('p', { class: 'section-hint' }, ['Your OpenRouter API key is stored securely by VS Code and never shown here.']),
    h('div', { class: 'row' }, [
      status,
      h('button', { onclick: () => post({ type: 'setApiKey' }) }, [s.apiKeySet ? 'Change Key' : 'Set Key']),
      clearBtn,
    ]),
  ]);
}

function effortCheckboxes(selected: string[], onChange: (next: string[]) => void): HTMLElement {
  const set = new Set(selected);
  const group = h('div', { class: 'effort-group' });
  for (const eff of EFFORTS) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = set.has(eff);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        set.add(eff);
      } else {
        set.delete(eff);
      }
      onChange(EFFORTS.filter((e) => set.has(e)));
    });
    group.append(h('label', { class: 'checkbox' }, [cb, eff]));
  }
  return group;
}

function generalSection(s: State): HTMLElement {
  // Base URL — commit on change (blur/Enter) so re-renders don't interrupt typing.
  const baseUrl = h('input', { type: 'text', value: s.baseUrl }) as HTMLInputElement;
  baseUrl.addEventListener('change', () => updateConfig('baseUrl', baseUrl.value.trim()));

  // Provider routing — assemble the object on any change.
  const routing: ProviderRouting = { ...s.providerRouting };
  const commitRouting = () => {
    const obj: ProviderRouting = {};
    if (routing.sort) {
      obj.sort = routing.sort;
    }
    if (routing.order && routing.order.length) {
      obj.order = routing.order;
    }
    if (routing.only && routing.only.length) {
      obj.only = routing.only;
    }
    if (typeof routing.allow_fallbacks === 'boolean') {
      obj.allow_fallbacks = routing.allow_fallbacks;
    }
    updateConfig('providerRouting', obj);
  };

  const sortSelect = h('select') as HTMLSelectElement;
  sortSelect.append(h('option', { value: '' }, ['(default)']));
  for (const so of SORTS) {
    const opt = h('option', { value: so }, [so]) as HTMLOptionElement;
    if (routing.sort === so) {
      opt.selected = true;
    }
    sortSelect.append(opt);
  }
  sortSelect.addEventListener('change', () => {
    routing.sort = sortSelect.value || undefined;
    commitRouting();
  });

  const orderInput = h('input', { type: 'text', value: (routing.order ?? []).join(', '), placeholder: 'e.g. DeepSeek, Together' }) as HTMLInputElement;
  orderInput.addEventListener('change', () => {
    routing.order = parseList(orderInput.value);
    commitRouting();
  });
  const onlyInput = h('input', { type: 'text', value: (routing.only ?? []).join(', '), placeholder: 'e.g. DeepSeek' }) as HTMLInputElement;
  onlyInput.addEventListener('change', () => {
    routing.only = parseList(onlyInput.value);
    commitRouting();
  });
  const fallbackCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  fallbackCb.checked = routing.allow_fallbacks ?? true;
  fallbackCb.addEventListener('change', () => {
    routing.allow_fallbacks = fallbackCb.checked;
    commitRouting();
  });

  return h('section', {}, [
    h('h2', {}, ['General']),
    h('div', { class: 'field' }, [
      h('label', {}, ['Base URL']),
      baseUrl,
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, ['Default reasoning effort levels']),
      h('span', { class: 'hint' }, ['Effort variants exposed for every reasoning model without an explicit per-model setting.']),
      effortCheckboxes(s.defaultEffortLevels, (next) => updateConfig('defaultEffortLevels', next)),
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, ['Provider routing']),
      h('span', { class: 'hint' }, ['Controls which upstream provider OpenRouter picks for each model.']),
      h('div', { class: 'row' }, [h('span', {}, ['Sort:']), sortSelect]),
      h('div', { class: 'field' }, [h('label', {}, ['Order (comma-separated)']), orderInput]),
      h('div', { class: 'field' }, [h('label', {}, ['Only (comma-separated)']), onlyInput]),
      h('label', { class: 'checkbox' }, [fallbackCb, 'Allow fallbacks']),
    ]),
  ]);
}

function textareaList(value: string[], placeholder: string, onCommit: (next: string[]) => void): HTMLTextAreaElement {
  const ta = h('textarea', { rows: 4, placeholder }) as HTMLTextAreaElement;
  ta.value = value.join('\n');
  ta.addEventListener('change', () => {
    const next = ta.value.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    onCommit(next);
  });
  return ta;
}

function commandSafetySection(s: State): HTMLElement {
  const cs = s.commandSafety;

  const enabledCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  enabledCb.checked = cs.enabled;
  enabledCb.addEventListener('change', () => updateConfig('commandSafety.enabled', enabledCb.checked));

  const aiCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  aiCb.checked = cs.aiEvaluation;
  aiCb.addEventListener('change', () => updateConfig('commandSafety.aiEvaluation', aiCb.checked));

  const levelSelect = h('select') as HTMLSelectElement;
  for (const [val, label] of [['green', '🟢 All commands (incl. read-only)'], ['orange', '🟠 Caution & Unsafe only'], ['red', '🔴 Unsafe only']] as const) {
    const opt = h('option', { value: val }, [label]) as HTMLOptionElement;
    if (cs.minLevelToShow === val) {
      opt.selected = true;
    }
    levelSelect.append(opt);
  }
  levelSelect.addEventListener('change', () => updateConfig('commandSafety.minLevelToShow', levelSelect.value));

  // Evaluation model: default to non-reasoning (fast) models; "Show all" overrides.
  const recommended = s.availableModels.filter((m) => !m.supportsReasoning);
  const list = showAllRiskModels ? s.availableModels : recommended;
  const modelSelect = h('select') as HTMLSelectElement;
  modelSelect.append(h('option', { value: '' }, ['(none — use built-in local rules)']));
  for (const m of list) {
    const opt = h('option', { value: m.id }, [`${m.name}  —  ${m.id}`]) as HTMLOptionElement;
    if (m.id === cs.model) {
      opt.selected = true;
    }
    modelSelect.append(opt);
  }
  if (cs.model && !list.some((m) => m.id === cs.model)) {
    const opt = h('option', { value: cs.model }, [`${cs.model}  (current)`]) as HTMLOptionElement;
    opt.selected = true;
    modelSelect.append(opt);
  }
  modelSelect.addEventListener('change', () => updateConfig('commandSafety.model', modelSelect.value));

  const showAllCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  showAllCb.checked = showAllRiskModels;
  showAllCb.addEventListener('change', () => {
    showAllRiskModels = showAllCb.checked;
    document.getElementById('safety-section')?.replaceWith(commandSafetySection(s));
  });

  const allowTa = textareaList(cs.allowList, 'One prefix per line, e.g.\nnpm run\ngit status\nls', (next) => updateConfig('commandSafety.allowList', next));
  const denyTa = textareaList(cs.denyList, 'One prefix per line, e.g.\nrm -rf\ngit push --force', (next) => updateConfig('commandSafety.denyList', next));

  const promptTa = h('textarea', { rows: 10, placeholder: 'Leave empty to use the built-in default prompt.' }) as HTMLTextAreaElement;
  promptTa.value = cs.prompt;
  promptTa.addEventListener('change', () => updateConfig('commandSafety.prompt', promptTa.value.trim()));
  const loadDefaultBtn = h('button', {
    class: 'secondary',
    onclick: () => { promptTa.value = s.defaultSafetyPrompt; },
  }, ['Load built-in default to edit']);

  const modalCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  modalCb.checked = cs.modalOnRed;
  modalCb.addEventListener('change', () => updateConfig('commandSafety.modalOnRed', modalCb.checked));

  const redactCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  redactCb.checked = cs.redactSecretFiles;
  redactCb.addEventListener('change', () => updateConfig('commandSafety.redactSecretFiles', redactCb.checked));
  const secretTa = textareaList(cs.secretFilePatterns, 'Extra patterns, one per line, e.g.\n*.token\nconfig/secrets.yml', (next) => updateConfig('commandSafety.secretFilePatterns', next));
  const redactObfCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  redactObfCb.checked = cs.redactObfuscatedReads;
  redactObfCb.addEventListener('change', () => updateConfig('commandSafety.redactObfuscatedReads', redactObfCb.checked));

  return h('section', { id: 'safety-section' }, [
    h('h2', {}, ['Command safety']),
    h('p', { class: 'section-hint' }, [
      'Shows an inline 🟢/🟠/🔴 verdict above every terminal command the agent proposes. Advisory only — you still approve via the normal confirmation card.',
    ]),
    h('label', { class: 'checkbox' }, [enabledCb, 'Enable command safety verdicts']),
    h('div', { class: 'field' }, [
      h('label', {}, ['Show verdict for']),
      levelSelect,
    ]),
    h('label', { class: 'checkbox' }, [aiCb, 'Evaluate every command with the model (recommended) — off uses local rules only']),
    h('div', { class: 'field' }, [
      h('label', {}, ['Evaluation model']),
      h('span', { class: 'hint' }, ['Runs on every terminal command — pick a fast, cheap model.']),
      modelSelect,
      h('label', { class: 'checkbox' }, [
        showAllCb,
        `Show all models — ${recommended.length} recommended, ${s.availableModels.length} total`,
      ]),
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, ['Always-safe commands (allow list)']),
      h('span', { class: 'hint' }, ['Prefixes always marked 🟢, skipping the model.']),
      allowTa,
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, ['Always-unsafe commands (block list)']),
      h('span', { class: 'hint' }, ['Prefixes always marked 🔴 (takes precedence over the allow list).']),
      denyTa,
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, ['Evaluation prompt']),
      h('span', { class: 'hint' }, ['Sent to the model; the command is appended automatically. Empty = built-in default.']),
      promptTa,
      h('div', { class: 'row' }, [loadDefaultBtn]),
    ]),
    h('label', { class: 'checkbox' }, [modalCb, 'Also show a blocking dialog for 🔴 unsafe commands']),
    h('h2', { class: 'subhead' }, ['Secret protection']),
    h('p', { class: 'section-hint' }, [
      'When the agent reads a sensitive file, its contents are replaced with a placeholder before the request is sent to OpenRouter — so secrets never leave your device. Covers file reads and terminal commands, including obfuscated/encoded ones.',
    ]),
    h('label', { class: 'checkbox' }, [redactCb, 'Redact secret-file contents from requests (recommended)']),
    h('div', { class: 'field' }, [
      h('label', {}, ['Extra secret-file patterns']),
      h('span', { class: 'hint' }, ['Added to built-in defaults (.env, *.pem, id_rsa, .aws/credentials, …). .example/.sample files are never treated as secrets. Encoded paths (chr()/octal/hex/base64) are reconstructed and matched too.']),
      secretTa,
    ]),
    h('label', { class: 'checkbox' }, [redactObfCb, 'Also redact output of obfuscated commands whose target can’t be verified (aggressive)']),
  ]);
}

function modelRow(s: State, m: ConfigurableModel): HTMLElement {
  const cfg = s.models[m.id] ?? {};
  const controls: HTMLElement[] = [];

  const enabledCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  enabledCb.checked = cfg.enabled !== false;
  enabledCb.addEventListener('change', () => updateModelConfig(m.id, { enabled: enabledCb.checked }));
  controls.push(h('label', { class: 'checkbox' }, [enabledCb, 'Enabled']));

  if (m.supportsReasoning) {
    controls.push(
      h('div', { class: 'row' }, [
        h('span', { class: 'muted' }, ['Effort:']),
        effortCheckboxes(cfg.effortLevels ?? [], (next) => updateModelConfig(m.id, { effortLevels: next })),
      ]),
    );
  }

  const cacheCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  cacheCb.checked = cfg.cacheControl === true;
  cacheCb.addEventListener('change', () => updateModelConfig(m.id, { cacheControl: cacheCb.checked }));
  controls.push(h('label', { class: 'checkbox' }, [cacheCb, 'Cache control']));

  return h('div', { class: 'model-row' }, [
    h('div', { class: 'model-head' }, [
      h('span', { class: 'model-name' }, [m.name]),
      h('span', { class: 'model-id' }, [m.id]),
    ]),
    h('div', { class: 'model-controls' }, controls),
  ]);
}

function renderModelList(container: HTMLElement, s: State): void {
  container.textContent = '';
  const q = searchQuery.trim().toLowerCase();
  const configured = new Set(Object.keys(s.models));
  const rows = s.availableModels.filter((m) => {
    if (q) {
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    }
    return configured.has(m.id);
  });

  if (rows.length === 0) {
    container.append(
      h('p', { class: 'muted' }, [
        q ? 'No models match your search.' : 'No models configured yet. Search above to find and configure a model.',
      ]),
    );
    return;
  }
  for (const m of rows) {
    container.append(modelRow(s, m));
  }
}

function modelsSection(s: State): HTMLElement {
  const list = h('div', { id: 'model-list' });
  const search = h('input', {
    type: 'text',
    id: 'model-search',
    placeholder: `Search ${s.availableModels.length} models by name or id…`,
    value: searchQuery,
  }) as HTMLInputElement;
  search.addEventListener('input', () => {
    searchQuery = search.value;
    renderModelList(list, s);
  });
  renderModelList(list, s);

  return h('section', {}, [
    h('h2', {}, ['Models']),
    h('p', { class: 'section-hint' }, ['Enable/disable models, expose reasoning-effort variants, and toggle explicit prompt-cache markers. Configured models always show; search to find others.']),
    search,
    list,
  ]);
}

function sessionStats(s: SessionSummary): HTMLElement {
  const stat = (value: string, label: string) =>
    h('div', { class: 'stat' }, [h('span', { class: 'value' }, [value]), h('span', { class: 'label' }, [label])]);
  return h('div', { class: 'stats', id: 'session-stats' }, [
    stat(String(s.turns), 'Turns'),
    stat('$' + s.totalCostUSD.toFixed(4), 'Cost'),
    stat(s.totalPromptTokens.toLocaleString(), 'Prompt tokens'),
    stat(s.totalCompletionTokens.toLocaleString(), 'Completion tokens'),
    stat(s.totalReasoningTokens.toLocaleString(), 'Reasoning tokens'),
  ]);
}

function sessionSection(s: State): HTMLElement {
  return h('section', { id: 'session-section' }, [
    h('h2', {}, ['Session usage']),
    sessionStats(s.session),
    h('button', { class: 'secondary', onclick: () => post({ type: 'resetSession' }) }, ['Reset session']),
  ]);
}

// --- render orchestration -----------------------------------------------------

function render(): void {
  const app = document.getElementById('app');
  if (!app || !state) {
    return;
  }
  app.textContent = '';
  app.append(
    apiKeySection(state),
    generalSection(state),
    commandSafetySection(state),
    modelsSection(state),
    sessionSection(state),
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; [k: string]: unknown };
  if (msg.type === 'state') {
    state = msg as unknown as State;
    render();
  } else if (msg.type === 'session' && state) {
    state.session = msg.session as SessionSummary;
    const node = document.getElementById('session-stats');
    if (node) {
      node.replaceWith(sessionStats(state.session));
    }
  }
});

post({ type: 'ready' });
