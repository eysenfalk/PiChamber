// The merge guard of worker and orchestrator sessions (#20): a shell command
// that merges a pull request whose base is `main` or pushes to `main` is
// refused. `dev` and every other branch stay open, since workers merge into
// `dev` under the owner's standing approval. It reads command text only, so a
// script or another tool gets past it; it is a best effort second layer, and
// the hard barrier is GitHub's rules for main and dev. Pure: the
// caller gathers the facts a verdict needs and asks again.
//
// A push also goes where the repository's configuration says: a push without
// a refspec follows push.default, remote.<name>.push and the upstream, and a
// remote with remote.<name>.mirror makes every push, `--tags` included, update
// and delete every branch. The guard reads that configuration and blocks when
// it can reach main; a mirror on any remote blocks, since which remote a push
// goes to is configuration as well. Configuration a push brings along changes
// what that read sees (`git -c` with any key, include.path and includeIf
// among them, `--config-env`, GIT_CONFIG_* variables), so every such push is
// blocked: its target is unclear. The facts are read before the whole command
// runs, so a command that also changes git configuration or remotes, or
// pushes from another directory than the session's, is blocked as well.
// The guard never asks git itself with
// `git push --dry-run`: that contacts the remote and would run the agent's
// own `--receive-pack`/`--exec` programs.

import { resolve } from 'node:path';

const PROTECTED = 'main';
const POLICY = 'Workers and orchestrators never merge into or push to main; the owner does. Merges and pushes to every other branch, dev included, stay allowed.';
const MAX_DEPTH = 6;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
// Programs that run the rest of their arguments as a command, with the options
// that take a value and those that change the directory.
const PREFIXES = {
  env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], chdir: ['-C', '--chdir'] },
  sudo: { values: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'], chdir: ['-D', '--chdir'] },
  command: {},
  builtin: {},
  exec: { values: ['-a'] },
  nohup: {},
  time: {},
  nice: { values: ['-n', '--adjustment'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  stdbuf: { values: ['-i', '-o', '-e'] },
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const GIT_GLOBAL_VALUES = new Set(['--namespace', '--super-prefix']);
// A GIT_CONFIG_* variable assigned, exported or set in PowerShell.
const GIT_CONFIG_ENV = /^(\$env:)?GIT_CONFIG\w*(=|$)/i;
// A configuration file inside a .git directory, worktrees' included.
const GIT_CONFIG_FILE = /(^|[\\/])\.git[\\/](.*[\\/])?config(\.worktree)?$/i;
// `git config` options and subcommands that only read.
const CONFIG_READS = /^(--get(-\w+)?|--list|-l|get|list)$/;
const REMOTE_READS = new Set([undefined, 'show', 'get-url']);
// Git commands that create a repository, and with it a configuration.
const REPOSITORY_CREATES = new Set(['clone', 'init']);
const GIT_REPOSITORY_OPTIONS = new Set(['--git-dir', '--work-tree']);
const PUSH_VALUES = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
const PR_MERGE_VALUES = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);
const API_VALUES = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
const API_FIELDS = new Set(['-f', '--raw-field', '-F', '--field']);
const MERGE_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;
// Git commands that can change the current branch or what it tracks before a
// later push in the same command; the branch read before the command runs no
// longer holds then.
const BRANCH_CHANGES = new Set(['checkout', 'switch', 'branch', 'config', 'symbolic-ref']);

/**
 * @typedef {{ fact: 'branch', dir: string | null }
 *   | { fact: 'pullBase', dir: string | null, repo?: string, selector?: string }
 *   | { fact: 'pushConfig', dir: string | null }
 *   | { fact: 'pullBaseById', id: string }} MergeFactNeed
 *   `branch` is the current branch of `dir` and the remote branch it tracks,
 *   `{ branch: string | null, upstream: string | null }` (null when detached or
 *   untracked). `pushConfig` is what decides the target of a push besides its
 *   refspecs, `{ pushDefault: string | null, mirror: boolean, refspecs: string[] }`
 *   (every remote's `remote.<name>.push` and `.mirror`). `pullBase` is the
 *   base branch name of the pull request `gh pr view <selector> --repo <repo>`
 *   finds in `dir`, `pullBaseById` the one of a GraphQL node id.
 * @typedef {{ value: unknown } | { error: string }} MergeFact
 * @typedef {{ decision: 'allow' } | { decision: 'block', reason: string }
 *   | { decision: 'need', needs: MergeFactNeed[] }} MergeVerdict
 */

/** The key of a fact in the `facts` record of `judgeCommand`. @param {MergeFactNeed} need */
export const factKey = (need) => [need.fact, need.dir ?? '', need.repo ?? '', need.selector ?? '', need.id ?? ''].join('\u0000');

const isMain = (ref) => ref.replace(/^(refs\/)?heads\//, '') === PROTECTED;

const splitOption = (arg) => {
  const equals = arg.indexOf('=');
  return arg.startsWith('--') && equals !== -1 ? [arg.slice(0, equals), arg.slice(equals + 1)] : [arg, undefined];
};

// Splits command text into words and separators. Quotes and escapes join
// words, `$(...)` and backticks are handed back as nested commands, and
// redirection targets and here-document bodies are dropped. A word with a
// shell expansion is marked `dynamic`: its value is not what the shell runs.
const tokenize = (text, shell) => {
  const escape = shell === 'powershell' ? '`' : '\\';
  const backticks = shell !== 'powershell';
  const items = [];
  const nested = [];
  const targets = [];
  let heredocs = [];
  let word = null;
  let redirect = null;
  const current = () => (word ??= { value: '', dynamic: false });
  const flush = () => {
    if (!word) return;
    if (redirect?.heredoc) heredocs.push({ delimiter: word.value, strip: redirect.strip });
    else if (redirect) targets.push(word);
    if (!redirect) items.push(word);
    redirect = null;
    word = null;
  };
  // The index of the character that closes a substitution opened before `start`.
  const closing = (start, open, close) => {
    let depth = 1;
    let quote = null;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) quote = null;
        else if (char === escape && quote === '"') index += 1;
      } else if (char === escape) index += 1;
      else if ((char === '\'' || char === '"') && open !== close) quote = char;
      else if (char === open && open !== close) depth += 1;
      else if (char === close && --depth === 0) return index;
    }
    return text.length;
  };
  const substitute = (start, open, close) => {
    const end = closing(start, open, close);
    nested.push(text.slice(start, end));
    current().dynamic = true;
    return end;
  };
  const skipHeredocs = (start) => {
    let position = start;
    for (const doc of heredocs) {
      while (position < text.length) {
        const newline = text.indexOf('\n', position);
        const end = newline === -1 ? text.length : newline;
        const line = text.slice(position, end);
        position = end + 1;
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
      }
    }
    heredocs = [];
    return position;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === escape) {
      if (next === '\n') index += 1;
      else if (next !== undefined) current().value += text[++index];
    } else if (char === '\'') {
      const end = text.indexOf('\'', index + 1);
      const stop = end === -1 ? text.length : end;
      current().value += text.slice(index + 1, stop);
      index = stop;
    } else if (char === '"') {
      const target = current();
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        const inner = text[index];
        if (inner === escape && index + 1 < text.length) target.value += text[++index];
        else if (inner === '$' && text[index + 1] === '(') index = substitute(index + 2, '(', ')');
        else if (inner === '`' && backticks) index = substitute(index + 1, '`', '`');
        else {
          if (inner === '$') target.dynamic = true;
          target.value += inner;
        }
      }
    } else if (char === '$' && next === '(') {
      index = substitute(index + 2, '(', ')');
    } else if (char === '`' && backticks) {
      index = substitute(index + 1, '`', '`');
    } else if (char === '$') {
      current().dynamic = true;
      word.value += char;
    } else if (char === '#' && !word) {
      const newline = text.indexOf('\n', index);
      index = (newline === -1 ? text.length : newline) - 1;
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      // A file descriptor number before the operator belongs to it.
      if (word && /^\d+$/.test(word.value) && !word.dynamic) word = null;
      else flush();
      let end = index;
      while (end < text.length && '<>&|'.includes(text[end])) end += 1;
      let operator = text.slice(index, end);
      if (operator === '<<' && text[end] === '-') {
        operator = '<<-';
        end += 1;
      }
      redirect = { heredoc: operator === '<<' || operator === '<<-', strip: operator === '<<-' };
      index = end - 1;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      flush();
    } else if (char === '\n') {
      flush();
      items.push({ op: 'sep' });
      if (heredocs.length) index = skipHeredocs(index + 1) - 1;
    } else if (char === ';' || char === '|' || char === '&') {
      flush();
      if (next === char || (char === '|' && next === '&')) index += 1;
      items.push({ op: 'sep' });
    } else if (char === '(' || char === ')') {
      flush();
      items.push({ op: char });
    } else {
      current().value += char;
    }
  }
  flush();
  return { items, nested, targets };
};

const changeDir = (dir, word) => {
  if (dir === null || !word || word.dynamic || /^[~-]/.test(word.value)) return null;
  return resolve(dir, word.value);
};

const programName = (word) => word.value.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

const block = (reason) => ({ reason });

// Where a refspec writes: every matching branch (`:`), a pattern, the current
// branch, or one named branch.
const refspecTarget = (refspec) => {
  const spec = refspec.replace(/^\+/, '');
  if (spec === ':') return { kind: 'matching' };
  const colon = spec.indexOf(':');
  const source = colon === -1 ? spec : spec.slice(0, colon);
  const destination = colon === -1 || colon === spec.length - 1 ? source : spec.slice(colon + 1);
  if (destination === 'HEAD' || destination === '@') return { kind: 'head' };
  if (destination.includes('*')) return { kind: 'wildcard' };
  return { kind: 'branch', name: destination };
};

// What the push configuration makes a push update: a mirror every branch, and
// for a push without a refspec (`bare`) the configured target. A configured
// `HEAD` is the current branch, which the branch check covers.
const judgePushConfig = ({ pushDefault, mirror, refspecs }, bare) => {
  if (mirror) return 'A remote of this repository is a mirror (remote.<name>.mirror), so git push, even with --tags, updates and deletes every branch, main included.';
  if (!bare) return null;
  if (pushDefault === 'matching') return 'git push without a refspec pushes every matching branch (push.default=matching), main included.';
  for (const refspec of refspecs) {
    const target = refspecTarget(refspec);
    if (target.kind === 'matching' || target.kind === 'wildcard') return `git push without a refspec uses the configured refspec ${refspec}, which can update main.`;
    if (target.kind === 'branch' && isMain(target.name)) return `git push without a refspec uses the configured refspec ${refspec}, which updates main.`;
  }
  return null;
};

const checkPush = (args, dir, out, configOverridden) => {
  if (configOverridden) {
    out.push(block('git push brings its own configuration (git -c, --config-env or a GIT_CONFIG_* variable), which can change where it pushes, so its target is unclear.'));
    return;
  }
  const positional = [];
  let everything = null;
  let tags = false;
  let repoOption = false;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const [flag] = splitOption(args[index].value);
    if (!options || !flag.startsWith('-') || flag === '-') positional.push(args[index]);
    else if (flag === '--') options = false;
    else if (flag === '--all' || flag === '--mirror' || flag === '--branches') everything = flag;
    else if (flag === '--tags') tags = true;
    else if (PUSH_VALUES.has(flag)) {
      if (flag === '--repo') repoOption = true;
      if (flag === args[index].value) index += 1;
    }
  }
  if (everything) {
    out.push(block(`git push ${everything} pushes every branch, main included.`));
    return;
  }
  const refspecs = repoOption ? positional : positional.slice(1);
  const currentBranch = (check) => out.push(out.branchChanged
    ? block('git push follows a git command that can change the current branch, so the branch it pushes is unknown before the command runs.')
    : { need: { fact: 'branch', dir }, judge: check });
  const bare = !refspecs.length && !tags;
  if (bare) {
    currentBranch(
      ({ branch, upstream }) => (branch === PROTECTED || upstream === PROTECTED
        ? `git push without a refspec on ${branch ?? 'a detached HEAD'}${upstream ? ` tracking ${upstream}` : ''} pushes to main.`
        : null),
    );
  }
  for (const refspec of refspecs) {
    if (refspec.dynamic) {
      out.push(block(`The target of the refspec ${refspec.value} depends on a shell expansion, so it may be main.`));
      continue;
    }
    const target = refspecTarget(refspec.value);
    if (target.kind === 'head') {
      currentBranch(({ branch }) => (branch === PROTECTED ? `git push ${refspec.value} pushes the current branch main.` : null));
    } else if (target.kind === 'matching') {
      out.push(block(`The refspec ${refspec.value} pushes every matching branch, main included.`));
    } else if (target.kind === 'wildcard') {
      out.push(block(`The wildcard refspec ${refspec.value} can update main.`));
    } else if (isMain(target.name)) {
      out.push(block(`git push ${refspec.value} updates main.`));
    }
  }
  if (dir !== null && dir !== out.cwd) {
    out.push(block('git push runs in another directory than the session (cd, git -C), possibly another repository, so its configuration is unclear.'));
    return;
  }
  out.push({ need: { fact: 'pushConfig', dir }, judge: (config) => judgePushConfig(config, bare) });
};

const checkGit = (args, dir, out) => {
  let gitDir = dir;
  let configOverridden = out.configEnv === true;
  let index = 0;
  for (; index < args.length; index += 1) {
    const value = args[index].value;
    const [flag, inline] = splitOption(value);
    if (value === '-C') gitDir = changeDir(gitDir, args[++index]);
    else if (value === '-c' || flag === '--config-env') {
      configOverridden = true;
      if (inline === undefined) index += 1;
    }
    else if (GIT_REPOSITORY_OPTIONS.has(flag)) {
      // The repository is no longer the directory's; its branch is unknown.
      gitDir = null;
      if (flag === value) index += 1;
    } else if (GIT_GLOBAL_VALUES.has(value)) index += 1;
    else if (!value.startsWith('-')) break;
  }
  const command = args[index]?.value;
  const rest = args.slice(index + 1);
  if (command === 'push') {
    out.pushes = true;
    checkPush(rest, gitDir, out, configOverridden);
    return;
  }
  if (BRANCH_CHANGES.has(command)) out.branchChanged = true;
  const subcommand = rest.find((word) => !word.value.startsWith('-'))?.value;
  if ((command === 'config' && !rest.some((word) => CONFIG_READS.test(word.value)))
    || (command === 'remote' && !REMOTE_READS.has(subcommand))
    || REPOSITORY_CREATES.has(command)) out.configChanged = true;
};

const checkPrMerge = (args, dir, out) => {
  let repo;
  let selector;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const [flag, inline] = splitOption(word.value);
    if (flag === '--disable-auto') return;
    if (flag === '-R' || flag === '--repo') {
      repo = inline === undefined ? args[++index] : { value: inline, dynamic: word.dynamic };
    } else if (flag.startsWith('-R') && flag.length > 2) {
      repo = { value: flag.slice(2), dynamic: word.dynamic };
    } else if (PR_MERGE_VALUES.has(flag)) {
      if (inline === undefined) index += 1;
    } else if (!flag.startsWith('-')) {
      selector ??= word;
    }
  }
  if (repo?.dynamic || selector?.dynamic || (repo && !repo.value)) {
    out.push(block('gh pr merge names its pull request through a shell expansion, so its base is unknown.'));
    return;
  }
  const what = selector ? `PR ${selector.value}` : 'the pull request of the current branch';
  out.push({
    need: { fact: 'pullBase', dir, ...(repo ? { repo: repo.value } : {}), ...(selector ? { selector: selector.value } : {}) },
    judge: (base) => (isMain(String(base)) ? `gh pr merge would merge ${what} into its base main.` : null),
    what: `gh pr merge of ${what}`,
  });
};

const checkApi = (args, dir, out) => {
  let endpoint;
  let method;
  let input = false;
  const fields = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const [flag, inline] = splitOption(word.value);
    if (flag === '-X' || flag === '--method') {
      method = (inline ?? args[++index]?.value ?? '').toUpperCase();
    } else if (flag.startsWith('-X') && flag.length > 2) {
      method = flag.slice(2).toUpperCase();
    } else if (flag === '--input') {
      input = true;
      if (inline === undefined) index += 1;
    } else if (API_FIELDS.has(flag) || /^-[fF]./.test(flag)) {
      const field = API_FIELDS.has(flag) ? (inline === undefined ? args[++index] : { value: inline, dynamic: word.dynamic }) : { value: flag.slice(2), dynamic: word.dynamic };
      const equals = field?.value.indexOf('=') ?? -1;
      if (equals > 0) fields.set(field.value.slice(0, equals), { value: field.value.slice(equals + 1), dynamic: field.dynamic });
    } else if (API_VALUES.has(flag)) {
      if (inline === undefined) index += 1;
    } else if (!flag.startsWith('-')) {
      endpoint ??= word;
    }
  }
  if (!endpoint || endpoint.dynamic) return;
  const path = endpoint.value.replace(/^\//, '').split('?')[0];
  const effective = method || (fields.size || input ? 'POST' : 'GET');

  if (path === 'graphql') {
    const query = fields.get('query');
    if (!query || !MERGE_MUTATIONS.test(query.value)) return;
    const literal = query.value.match(/pullRequestId\s*:\s*"([^"]+)"/);
    const variable = query.value.match(/pullRequestId\s*:\s*\$(\w+)/);
    const id = literal ? { value: literal[1], dynamic: query.dynamic } : variable ? fields.get(variable[1]) : undefined;
    if (!id || id.dynamic) {
      out.push(block('A GraphQL merge names no pull request id this guard can read, so its base is unknown.'));
      return;
    }
    out.push({
      need: { fact: 'pullBaseById', id: id.value },
      judge: (base) => (isMain(String(base)) ? 'The GraphQL merge targets a pull request whose base is main.' : null),
      what: `the GraphQL merge of ${id.value}`,
    });
    return;
  }

  const pull = path.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/merge$/);
  if (pull) {
    if (effective === 'GET') return;
    const repo = pull[1].startsWith('{') ? undefined : `${pull[1]}/${pull[2]}`;
    out.push({
      need: { fact: 'pullBase', dir, ...(repo ? { repo } : {}), selector: pull[3] },
      judge: (base) => (isMain(String(base)) ? `The API call merges PR ${pull[3]} into its base main.` : null),
      what: `the API merge of PR ${pull[3]}`,
    });
    return;
  }

  if (/^repos\/[^/]+\/[^/]+\/merges$/.test(path) && effective !== 'GET') {
    const base = fields.get('base');
    if (input || !base || base.dynamic || base.value.startsWith('@')) {
      out.push(block('The API merge names no base this guard can read, so it may be main.'));
    } else if (isMain(base.value)) {
      out.push(block('The API call merges into main.'));
    }
  }
};

const checkGh = (args, dir, out) => {
  const commands = args.filter((word) => !word.value.startsWith('-'));
  const [group, action] = commands.map((word) => word.value);
  if (group === 'pr' && action === 'merge') {
    checkPrMerge(args.slice(args.indexOf(commands[1]) + 1), dir, out);
  } else if (group === 'api') {
    checkApi(args.slice(args.indexOf(commands[0]) + 1), dir, out);
  }
};

// Checks one simple command and returns the directory the next one runs in.
const invocation = (words, dir, shell, depth, out) => {
  let local = dir;
  let index = 0;
  // A GIT_CONFIG_* variable configures every later git command.
  if (words.some((word) => GIT_CONFIG_ENV.test(word.value))) out.configEnv = true;
  if (words.some((word) => GIT_CONFIG_FILE.test(word.value))) out.configChanged = true;
  while (index < words.length) {
    const value = words[index].value;
    if (ASSIGNMENT.test(value) || KEYWORDS.has(value)) {
      index += 1;
      continue;
    }
    const spec = PREFIXES[programName(words[index])];
    if (!spec) break;
    for (index += 1; index < words.length; index += 1) {
      const [flag, inline] = splitOption(words[index].value);
      if (flag === '--') {
        index += 1;
        break;
      }
      if (!flag.startsWith('-') || flag === '-') break;
      if (spec.chdir?.includes(flag)) local = changeDir(local, inline === undefined ? words[index + 1] : { value: inline, dynamic: words[index].dynamic });
      if (spec.values?.includes(flag) && inline === undefined) index += 1;
    }
    index += spec.positional ?? 0;
  }
  const rest = words.slice(index);
  if (!rest.length) return dir;
  const name = programName(rest[0]);
  const args = rest.slice(1);
  if (name === 'cd' || name === 'pushd' || name === 'set-location') {
    const target = args.filter((word) => !/^-[LPe@]$/.test(word.value));
    return changeDir(dir, target[0]);
  }
  if (name === 'eval') {
    walk(args.map((word) => word.value).join(' '), local, shell, depth + 1, out);
  } else if (SHELLS.has(name)) {
    const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word.value));
    if (flag !== -1 && args[flag + 1]) walk(args[flag + 1].value, local, 'bash', depth + 1, out);
  } else if (POWERSHELLS.has(name)) {
    const flag = args.findIndex((word) => /^-(c|command)$/i.test(word.value));
    if (flag !== -1) walk(args.slice(flag + 1).map((word) => word.value).join(' '), local, 'powershell', depth + 1, out);
  } else if (name === 'git') {
    checkGit(args, local, out);
  } else if (name === 'gh') {
    checkGh(args, local, out);
  }
  return dir;
};

// Collects the checks of every command in `text`, in the order the shell runs
// them, into `out`; `out.branchChanged` marks that a git command which can
// change the current branch ran before.
const walk = (text, cwd, shell, depth, out) => {
  if (depth > MAX_DEPTH) {
    out.push(block('The command nests shells too deeply to check.'));
    return;
  }
  const { items, nested, targets } = tokenize(text, shell);
  if (targets.some((word) => GIT_CONFIG_FILE.test(word.value))) out.configChanged = true;
  for (const inner of nested) walk(inner, cwd, shell, depth + 1, out);
  let dir = cwd;
  const scopes = [];
  let words = [];
  const end = () => {
    if (words.length) dir = invocation(words, dir, shell, depth, out);
    words = [];
  };
  for (const item of items) {
    if (!('op' in item)) words.push(item);
    else {
      end();
      // A subshell's `cd` ends with it.
      if (item.op === '(') scopes.push(dir);
      else if (item.op === ')' && scopes.length) dir = scopes.pop();
    }
  }
  end();
};

/**
 * Judges a `bash` or `powershell` command of a guarded session.
 * @param {string} command
 * @param {{ cwd: string | null, shell?: 'bash' | 'powershell', facts?: Record<string, MergeFact> }} options
 *   `facts` holds the answers to an earlier `need`, keyed by `factKey`.
 * @returns {MergeVerdict}
 */
export const judgeCommand = (command, { cwd, shell = 'bash', facts = {} }) => {
  const checks = [];
  checks.cwd = cwd;
  walk(command, cwd, shell, 0, checks);
  if (checks.pushes && checks.configChanged) {
    return { decision: 'block', reason: `The command changes git configuration or remotes (git config, git remote, git clone or init, a config file in .git) and pushes; the push target is read before the command runs, so it is unclear. ${POLICY}` };
  }
  const needs = new Map();
  for (const check of checks) {
    if (check.reason) return { decision: 'block', reason: `${check.reason} ${POLICY}` };
    const { need } = check;
    if ('dir' in need && need.dir === null) {
      return { decision: 'block', reason: `The directory ${check.what ?? 'git push'} runs in is unknown, so its target may be main. ${POLICY}` };
    }
    const key = factKey(need);
    const fact = facts[key];
    if (!fact) {
      needs.set(key, need);
    } else if ('error' in fact) {
      return { decision: 'block', reason: `The lookup for ${check.what ?? 'git push'} failed, so its target may be main: ${fact.error} ${POLICY}` };
    } else {
      const reason = check.judge(fact.value);
      if (reason) return { decision: 'block', reason: `${reason} ${POLICY}` };
    }
  }
  return needs.size ? { decision: 'need', needs: [...needs.values()] } : { decision: 'allow' };
};
