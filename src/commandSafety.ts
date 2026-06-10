// Local, synchronous terminal-command safety assessor. Pure logic — no vscode
// import — so it can be unit-tested and reused. Mirrors the green/orange/red
// intent of VS Code core's risk prompt. The model fallback (in ChatProvider) is
// only consulted when assessLocal returns certain=false.

export type Risk = 'green' | 'orange' | 'red';

export interface Verdict {
  risk: Risk;
  reason: string;
}

// Invisible sentinel (two word-joiners) placed inside the rendered blockquote so
// we can strip our own notes from history without anything visible leaking into
// the chat (an HTML comment renders as literal text in the chat surface).
export const MARKER = '⁠⁠';

const ICON: Record<Risk, string> = { green: '🟢', orange: '🟠', red: '🔴' };
const LABEL: Record<Risk, string> = { green: 'Safe', orange: 'Caution', red: 'Unsafe' };

export const RISK_RANK: Record<Risk, number> = { green: 0, orange: 1, red: 2 };

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function renderVerdict(v: Verdict): string {
  const reason = oneLine(v.reason) || 'No details.';
  // A titled blockquote callout: emoji + bold heading, then the reason.
  return `\n> ${MARKER}${ICON[v.risk]} **Command safety — ${LABEL[v.risk]}**\n>\n> ${reason}\n\n`;
}

// The injected note becomes part of the assistant turn and would re-enter the
// upstream history on later requests. Strip our sentinel block before sending.
export function stripRiskNotes(text: string): string {
  return text.replace(/\n*>[ ]?⁠⁠[^\n]*(?:\n>[^\n]*)*\n*/g, '\n');
}

export function isTerminalTool(name: string): boolean {
  return name === 'run_in_terminal' || /run.*terminal/i.test(name);
}

// Comprehensive default instruction for the model classifier. Users can override
// it via orcp.commandSafety.prompt; the command is appended after these rules.
export const DEFAULT_SAFETY_PROMPT = `You are a terminal-command safety classifier for an AI coding agent running on a developer's machine. Classify the SINGLE command into exactly one risk level and give a short reason.

Risk levels:
- "green" (Safe): read-only or inspection commands that do not modify files, system state, or anything remote. e.g. ls, cat, grep, find, git status/log/diff, ps, df, echo, type-checks/builds with no side effects.
- "orange" (Caution): modifies the local workspace or recoverable state, or changes remote state in a low-impact/undoable way. e.g. creating/editing/moving files, mkdir, output redirection, installing dependencies (npm/pip/cargo/apt/brew), git add/commit/checkout/stash, deleting recoverable build output (node_modules, dist, .cache), a normal git push.
- "red" (Unsafe): irreversible, destructive, or high-impact. e.g. deleting source code or user data (rm -rf on source/home/root paths), git push --force, pushed history rewrites, disk/partition ops (dd, mkfs, format), piping a remote script to a shell (curl|sh, wget|bash), dropping databases, publishing packages, broad sudo, anything exfiltrating secrets or executing untrusted code.

Container & privilege-escalation rules (treat as red): a container runs as root inside, so ANY bind-mount of a host path (docker/podman -v or --mount) exposes host files — especially sensitive paths (/, /etc, /root, /home, /var, /var/run/docker.sock, ~, SSH dirs). Also red: --privileged, --cap-add (SYS_ADMIN etc.), --security-opt …=unconfined, host namespaces (--pid/ipc/uts/userns=host), mounting the Docker socket, nsenter or unshare into host namespaces, and reading /etc/shadow, SSH private keys, or /proc/<pid>/root. Do not assume a partial bind mount like "-v /etc:/x" is safe — it is not.

Guidance:
- Judge the real effect, accounting for flags, targets, pipes, and chained sub-commands (&&, ||, ;, |). If any part is unsafe, the whole command is unsafe.
- If the command runs or sources a script/file, its contents may be provided below. Judge by what the script ACTUALLY does, not by the innocent-looking command line. Treat obfuscation as unsafe: base64/hex/encoded payloads that get decoded and executed, eval/exec of dynamic strings, downloading-and-running code, or destructive operations hidden inside the file.
- When genuinely torn between two levels, pick the higher (more cautious) one.
- The reason must be specific: name the actual flag, path, branch, or action (e.g. "Force-pushes main, overwriting remote history.", "Script base64-decodes and executes a payload."). Max 18 words, no markdown.

Respond with STRICT JSON only — no prose, no code fences:
{"risk":"green|orange|red","reason":"<one short sentence>"}`;

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

// Heuristically find local script files a command executes, plus any `cd`
// directories that help resolve relative paths. Used to read script contents and
// fold them into the verdict (so obfuscated payloads in a file aren't missed).
export function extractScriptRefs(command: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];

  for (const m of command.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    const d = unquote(m[1]);
    if (d && d !== '-' && d !== '~') {
      dirs.push(d);
    }
  }

  // interpreter <file>
  const interp = /\b(?:python3?|node|deno|bun|ts-node|bash|sh|zsh|ruby|perl|php|pwsh|powershell)\s+("[^"]+"|'[^']+'|[^\s;|&]+)/g;
  for (const m of command.matchAll(interp)) {
    const f = unquote(m[1]);
    if (f && !f.startsWith('-')) {
      files.push(f);
    }
  }

  // source <file>  /  . <file>
  for (const m of command.matchAll(/(?:\bsource|(?:^|[\s;|&])\.)\s+("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    files.push(unquote(m[1]));
  }

  // ./script or a path with a known script extension
  for (const m of command.matchAll(/(?:^|[\s;|&(])((?:\.\/|\/|~\/)?[^\s;|&]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1))\b/g)) {
    files.push(m[1]);
  }
  for (const m of command.matchAll(/(?:^|[\s;|&])(\.\/[^\s;|&]+)/g)) {
    files.push(m[1]);
  }

  return { dirs: [...new Set(dirs)], files: [...new Set(files)] };
}

// True if the command (or any of its sub-commands) begins with one of the given
// prefixes, matched on a word boundary so "git" won't match "github-cli".
export function listMatch(command: string, prefixes: readonly string[]): boolean {
  const candidates = [command.trim(), ...splitSubCommands(command)];
  return prefixes.some((raw) => {
    const pre = raw.trim();
    if (!pre) {
      return false;
    }
    return candidates.some((c) => c === pre || c.startsWith(pre + ' '));
  });
}

// Split a command line into independently-run sub-commands.
export function splitSubCommands(line: string): string[] {
  return line
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Recoverable delete targets — `rm -rf` on these is annoying, not catastrophic.
const RECOVERABLE = /\b(node_modules|dist|build|out|\.cache|\.next|\.turbo|coverage|target|__pycache__)\b|(^|\s)\/tmp(\/|\s|$)/;

// Lead binaries we consider read-only / safe.
const SAFE_LEADS = new Set([
  'ls', 'cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'ag', 'find', 'fd',
  'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'file', 'stat', 'wc',
  'ps', 'top', 'htop', 'df', 'du', 'free', 'uname', 'whoami', 'id', 'env',
  'date', 'uptime', 'hostname', 'tree', 'diff', 'cmp', 'sort', 'uniq', 'cut',
  'awk', 'sed', 'jq', 'node', 'python', 'python3', 'code', 'history',
]);

const SAFE_GIT_SUBS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'blame', 'describe', 'rev-parse', 'ls-files', 'stash']);

function leadToken(sub: string): string {
  const m = sub.trim().match(/^([^\s]+)/);
  return m ? m[1].toLowerCase() : '';
}

function firstPathArg(sub: string): string {
  // crude: first non-flag token after the binary
  const parts = sub.trim().split(/\s+/).slice(1).filter((t) => !t.startsWith('-'));
  return parts[0] ?? '';
}

const PIPE_TO_INTERPRETER = /\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i;

// Markers that a command is hiding its real behavior behind encoding/indirection.
const OBFUSCATION_RE = /\b(base64|base32|xxd|uudecode|openssl\s+enc|atob|btoa)\b|\beval\b|\bexec\s|\\x[0-9a-f]{2}|\\[0-7]{3}|\\u[0-9a-f]{4}/i;

// Undo cheap token-splitting obfuscation: `\o` -> `o`, empty quote pairs removed.
// So `--priv""ileged` -> `--privileged`, `d\ocker` -> `docker`, `/''etc` -> `/etc`.
function deobfuscate(s: string): string {
  return s.replace(/\\([A-Za-z0-9$/.])/g, '$1').replace(/''|""/g, '');
}

// Pull out code hidden inside `sh -c "…"`, `eval "…"`, $( … ), and backticks.
function extractWrappedPayloads(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(?:^|\s)(?:-c|eval)\s+("([^"]*)"|'([^']*)')/g)) {
    out.push(m[2] ?? m[3] ?? '');
  }
  for (const m of s.matchAll(/\$\(([^()]*)\)/g)) {
    out.push(m[1]);
  }
  for (const m of s.matchAll(/`([^`]*)`/g)) {
    out.push(m[1]);
  }
  return out.filter((p) => p.trim().length > 0);
}

function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) {
    return false;
  }
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) {
      printable++;
    }
  }
  return printable / s.length > 0.85;
}

// Decode base64-looking tokens so an encoded payload is scanned/judged on its
// real contents. Returns only tokens that decode to plausible text.
export function decodeBase64Candidates(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)) {
    const tok = m[0];
    try {
      const decoded = typeof Buffer !== 'undefined'
        ? Buffer.from(tok, 'base64').toString('utf8')
        : (typeof atob !== 'undefined' ? atob(tok) : '');
      if (decoded.length >= 4 && isMostlyPrintable(decoded) && /[A-Za-z/ -]/.test(decoded)) {
        out.push(decoded);
      }
    } catch {
      // not base64
    }
  }
  return out;
}

// All string variants the local rules should scan: the raw line, each
// sub-command, their de-obfuscated forms, and any unwrapped/decoded payloads.
function scanTargets(commandLine: string): string[] {
  const set = new Set<string>();
  const add = (s: string): void => {
    const t = s.trim();
    if (t) {
      set.add(t);
      const d = deobfuscate(t);
      if (d !== t) {
        set.add(d);
      }
    }
  };
  add(commandLine);
  for (const s of splitSubCommands(commandLine)) {
    add(s);
  }
  for (const payload of [...extractWrappedPayloads(commandLine), ...decodeBase64Candidates(commandLine)]) {
    add(payload);
    for (const s of splitSubCommands(payload)) {
      add(s);
    }
  }
  return [...set].slice(0, 80);
}

const CONTAINER_CLI = /\b(docker|podman|nerdctl)\b/i;
// Host paths that must never be bind-mounted into a container (it runs as root).
const SENSITIVE_HOST_ROOT = /^\/(etc|root|home|var|usr|bin|sbin|boot|lib|lib64|sys|proc|dev|run|srv|opt|mnt|media|users|private)(\/|$)/i;
const CONTAINER_READONLY = new Set(['ps', 'images', 'image', 'logs', 'inspect', 'version', 'info', 'top', 'stats', 'port', 'history', 'search', 'context', 'system']);

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

function isAbsoluteHostPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^\$\{?(HOME|PWD)\b/i.test(p);
}

function isSensitiveHostPath(p: string): boolean {
  if (p === '/' || p === '~' || /^\$\{?HOME\b/i.test(p) || p.startsWith('~/')) {
    return true;
  }
  return SENSITIVE_HOST_ROOT.test(p);
}

// Host-side sources of `-v src:dst`, `--volume src:dst`, and `--mount …,source=src`.
function bindMountSources(sub: string): string[] {
  const out: string[] = [];
  for (const m of sub.matchAll(/(?:^|\s)(?:-v|--volume)[=\s]+("[^"]+"|'[^']+'|[^\s]+)/g)) {
    const src = stripQuotes(m[1]).split(':')[0];
    if (src) {
      out.push(src);
    }
  }
  for (const m of sub.matchAll(/--mount[=\s]+("[^"]+"|'[^']+'|[^\s]+)/g)) {
    const sm = stripQuotes(m[1]).match(/(?:^|,)(?:src|source)=([^,]+)/i);
    if (sm) {
      out.push(sm[1]);
    }
  }
  return out;
}

function containerSubcommand(sub: string): string {
  return (sub.match(/\b(?:docker|podman|nerdctl)\s+(\w+)/i)?.[1] ?? '').toLowerCase();
}

function assessRed(sub: string): Verdict | undefined {
  // Container escape / privilege escalation.
  if (CONTAINER_CLI.test(sub)) {
    if (/--privileged\b/i.test(sub)) {
      return { risk: 'red', reason: 'Runs a --privileged container — full host access / trivial escape.' };
    }
    if (/--cap-add[=\s]+["']?(all|sys_admin|sys_ptrace|sys_module|sys_boot|dac_read_search|dac_override|net_admin)/i.test(sub)) {
      return { risk: 'red', reason: 'Adds dangerous Linux capabilities to a container — escape risk.' };
    }
    if (/--security-opt[=\s]+\S*(apparmor=unconfined|seccomp=unconfined|systempaths=unconfined)/i.test(sub)) {
      return { risk: 'red', reason: 'Disables container sandboxing (unconfined apparmor/seccomp).' };
    }
    if (/--(pid|ipc|uts|userns)[=\s]+host\b/i.test(sub)) {
      return { risk: 'red', reason: 'Shares a host namespace with the container — escape risk.' };
    }
    if (/docker\.sock\b/i.test(sub)) {
      return { risk: 'red', reason: 'Mounts the Docker socket — equivalent to host root.' };
    }
    for (const src of bindMountSources(sub)) {
      if (isSensitiveHostPath(src)) {
        return { risk: 'red', reason: `Bind-mounts sensitive host path "${src}" into a container — exposes host files.` };
      }
    }
  }
  // Namespace escalation outside Docker.
  if (/\bnsenter\b/i.test(sub)) {
    return { risk: 'red', reason: 'Enters host namespaces (nsenter) — full host access.' };
  }
  if (/\bunshare\b/i.test(sub) && /(-\w*r|--map-root-user|--map-root|--user)/i.test(sub)) {
    return { risk: 'red', reason: 'Creates a root-mapped user namespace (unshare) — privilege escalation.' };
  }
  // Credential / host-filesystem access.
  if (/\/etc\/(shadow|gshadow|sudoers)\b/i.test(sub)) {
    return { risk: 'red', reason: 'Accesses a credential file (/etc/shadow or sudoers).' };
  }
  if (/\/proc\/(1|\d+)\/root\b/i.test(sub)) {
    return { risk: 'red', reason: 'Reads the host filesystem via /proc/<pid>/root.' };
  }
  if (/\bid_(rsa|ed25519|ecdsa|dsa)\b|\.ssh\/(id_|authorized_keys)/i.test(sub)) {
    return { risk: 'red', reason: 'Accesses SSH private keys.' };
  }
  // Remote code execution: curl/wget/fetch piped to a shell.
  if (/\b(curl|wget|fetch)\b/i.test(sub) && PIPE_TO_INTERPRETER.test(sub)) {
    return { risk: 'red', reason: 'Pipes a remote script straight to a shell — arbitrary code execution.' };
  }
  // Base64/obfuscated payload decoded then executed.
  if (/\bbase64\b[^|]*(-d|--decode|-D)\b/i.test(sub) && PIPE_TO_INTERPRETER.test(sub)) {
    return { risk: 'red', reason: 'Base64-decodes then pipes into a shell — obfuscated execution.' };
  }
  // Echoed/printed text piped into a bare shell.
  if (/\b(echo|printf|cat)\b/i.test(sub) && /\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b(\s|$|;|&)/i.test(sub)) {
    return { risk: 'red', reason: 'Pipes generated text into a shell — possible obfuscated execution.' };
  }
  // eval/exec of encoded/decoded data (shell or script).
  if (/\b(eval|exec)\b/i.test(sub) && /(base64|atob|fromcharcode|--decode|\\x[0-9a-f]{2})/i.test(sub)) {
    return { risk: 'red', reason: 'Evaluates decoded/encoded data — obfuscated code execution.' };
  }
  // git force push.
  if (/\bgit\s+push\b/i.test(sub) && /(--force\b|--force-with-lease\b|\s-f\b)/i.test(sub)) {
    const branch = sub.match(/push\s+\S+\s+(\S+)/i)?.[1] ?? 'the branch';
    return { risk: 'red', reason: `Force-pushes ${branch} — can overwrite remote history.` };
  }
  // Destructive disk / fs ops.
  if (/\bmkfs(\.\w+)?\b/i.test(sub)) {
    return { risk: 'red', reason: 'Formats a filesystem — destroys all data on the target.' };
  }
  if (/\bdd\b.*\bof=\/dev\//i.test(sub)) {
    return { risk: 'red', reason: 'Writes raw data to a device — can wipe a disk.' };
  }
  if (/:\(\)\s*\{.*:\|:.*\}/.test(sub)) {
    return { risk: 'red', reason: 'Fork bomb — will exhaust system resources.' };
  }
  // Irreversible recursive delete (not a recoverable build dir).
  if (/\brm\b/i.test(sub) && /\s-[a-z]*r[a-z]*/i.test(sub) && /\s-[a-z]*f[a-z]*|\s-[a-z]*r[a-z]*f|\s-rf\b|\s-fr\b/i.test(sub)) {
    const target = firstPathArg(sub) || 'files';
    if (/(^|\s)(\/|~|\$home)(\s|$)/i.test(sub) || /\s-[a-z]*\s+\/\s|\s\/\s|\s\/$/.test(sub)) {
      return { risk: 'red', reason: 'Recursively force-deletes a root/home path — irreversible.' };
    }
    if (!RECOVERABLE.test(sub)) {
      return { risk: 'red', reason: `Recursively force-deletes ${target} — irreversible loss of source/data.` };
    }
  }
  // npm publish.
  if (/\bnpm\s+publish\b/i.test(sub)) {
    return { risk: 'red', reason: 'Publishes a package to the registry — public and hard to undo.' };
  }
  // SQL drop / database destroy.
  if (/\bdrop\s+(database|table|schema)\b/i.test(sub)) {
    return { risk: 'red', reason: 'Drops a database object — irreversible data loss.' };
  }
  return undefined;
}

function assessOrange(sub: string): Verdict | undefined {
  // Container commands (dangerous variants already returned red above).
  if (CONTAINER_CLI.test(sub)) {
    for (const src of bindMountSources(sub)) {
      if (isAbsoluteHostPath(src)) {
        return { risk: 'orange', reason: `Bind-mounts host path "${src}" into a container.` };
      }
    }
    const subcmd = containerSubcommand(sub);
    if (subcmd && !CONTAINER_READONLY.has(subcmd)) {
      return { risk: 'orange', reason: `Runs a container command (${subcmd}) — executes code in a container.` };
    }
  }
  // git push (non-force already filtered to red above).
  if (/\bgit\s+push\b/i.test(sub)) {
    return { risk: 'orange', reason: 'Pushes commits to a remote — modifies shared state.' };
  }
  // Recoverable recursive delete.
  if (/\brm\b/i.test(sub) && /\s-[a-z]*r/i.test(sub)) {
    const target = firstPathArg(sub) || 'a directory';
    return { risk: 'orange', reason: `Deletes ${target} — recoverable by reinstall/rebuild.` };
  }
  if (/\brm\b/i.test(sub)) {
    return { risk: 'orange', reason: `Removes ${firstPathArg(sub) || 'a file'}.` };
  }
  // Package installs.
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i.test(sub) || /\b(pip|pip3)\s+install\b/i.test(sub) || /\bcargo\s+(add|install)\b/i.test(sub) || /\bapt(-get)?\s+install\b/i.test(sub) || /\bbrew\s+install\b/i.test(sub)) {
    return { risk: 'orange', reason: 'Installs packages — runs third-party install scripts and changes deps.' };
  }
  // git history-altering but local.
  if (/\bgit\s+(reset|rebase|checkout|clean)\b/i.test(sub)) {
    return { risk: 'orange', reason: 'Alters local git state — may discard changes.' };
  }
  // Local file mutations.
  if (/\b(mkdir|mv|cp|touch|ln|chmod|chown|sed\s+-i)\b/i.test(sub)) {
    return { risk: 'orange', reason: 'Modifies local files.' };
  }
  // Output redirection that writes/overwrites a file.
  if (/(^|[^>])>>?(?!&)/.test(sub) && !/\b(grep|rg|find)\b/i.test(sub)) {
    return { risk: 'orange', reason: 'Redirects output to a file — overwrites or appends.' };
  }
  return undefined;
}

function assessGreen(sub: string): boolean {
  const lead = leadToken(sub);
  if (lead === 'git') {
    const gitSub = sub.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
    return SAFE_GIT_SUBS.has(gitSub);
  }
  return SAFE_LEADS.has(lead);
}

export function assessLocal(commandLine: string): { verdict: Verdict; certain: boolean } {
  const subs = splitSubCommands(commandLine);
  if (subs.length === 0) {
    return { verdict: { risk: 'green', reason: 'No command to run.' }, certain: true };
  }

  // Scan the raw line, every sub-command, their de-obfuscated forms, and any
  // unwrapped (sh -c / eval / $() ) or base64-decoded payloads.
  const targets = scanTargets(commandLine);
  for (const t of targets) {
    const red = assessRed(t);
    if (red) {
      return { verdict: red, certain: true };
    }
  }
  for (const t of targets) {
    const orange = assessOrange(t);
    if (orange) {
      return { verdict: orange, certain: true };
    }
  }

  // Nothing matched, but the command hides its behavior behind encoding/indirection:
  // don't call it safe — flag caution and mark uncertain so the model also reviews.
  if (OBFUSCATION_RE.test(commandLine) || decodeBase64Candidates(commandLine).length > 0) {
    return {
      verdict: { risk: 'orange', reason: 'Obfuscated or encoded command — hides its real behavior; review carefully.' },
      certain: false,
    };
  }

  // No mutation rule matched. Certain only if every sub-command is a known-safe read.
  const allKnownSafe = subs.every(assessGreen);
  return {
    verdict: { risk: 'green', reason: 'Read-only — does not modify files or remote state.' },
    certain: allKnownSafe,
  };
}
