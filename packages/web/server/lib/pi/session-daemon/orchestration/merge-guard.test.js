import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { factKey, judgeCommand } from './merge-guard.js';
import { createOrchestrationExtension } from './pi-extension.js';

const cwd = '/work/repo';

// Judges a command and answers the facts it asks for with `answer(need)`.
const judge = (command, answer = () => undefined, shell = 'bash') => {
  const first = judgeCommand(command, { cwd, shell });
  if (first.decision !== 'need') return first;
  const facts = Object.fromEntries(first.needs.map((need) => [factKey(need), answer(need)]));
  return judgeCommand(command, { cwd, shell, facts });
};
const NO_PUSH_CONFIG = { pushDefault: null, mirror: false, refspecs: [] };
const onBranch = (branch, upstream = branch, pushConfig = NO_PUSH_CONFIG) => (need) => {
  if (need.fact === 'branch') return { value: { branch, upstream } };
  return need.fact === 'pushConfig' ? { value: { ...NO_PUSH_CONFIG, ...pushConfig } } : undefined;
};
const withBase = (base) => (need) => (need.fact.startsWith('pullBase') ? { value: base } : undefined);

describe('judgeCommand', () => {
  it.each([
    ['a refspec onto main', 'git push origin HEAD:main', /HEAD:main updates main/],
    ['main by name', 'git push origin main', /git push main updates main/],
    ['the full ref', 'git push origin HEAD:refs/heads/main', /updates main/],
    ['a bare full ref', 'git push origin refs/heads/main', /updates main/],
    ['a forced refspec', 'git push origin +feature:main', /\+feature:main updates main/],
    ['a deleting refspec', 'git push origin :main', /:main updates main/],
    ['--delete main', 'git push origin --delete main', /updates main/],
    ['--all', 'git push --all origin', /--all pushes every branch/],
    ['--mirror', 'git push --mirror backup', /--mirror pushes every branch/],
    ['--branches', 'git push origin --branches', /--branches pushes every branch/],
    ['a wildcard refspec', 'git push origin "refs/heads/*:refs/heads/*"', /wildcard/],
    ['a refspec target from a variable', 'git push origin "HEAD:$TARGET"', /shell expansion/],
    ['after &&', 'git status && git push origin main', /updates main/],
    ['after ||', 'false || git push origin main', /updates main/],
    ['after ;', 'echo start; git push origin main', /updates main/],
    ['in a pipe', 'git push origin main 2>&1 | tee push.log', /updates main/],
    ['on a later line', 'echo start\ngit push origin main', /updates main/],
    ['in a subshell', '(cd sub && git push origin main)', /updates main/],
    ['in a command substitution', 'echo "$(git push origin main)"', /updates main/],
    ['in backticks', 'echo `git push origin main`', /updates main/],
    ['through bash -c', 'bash -lc "git push origin main"', /updates main/],
    ['through eval', 'eval git push origin main', /updates main/],
    ['behind env', 'env GIT_TRACE=1 git push origin main', /updates main/],
    ['behind an assignment', 'GIT_SSH_COMMAND=ssh git push origin main', /updates main/],
    ['behind sudo', 'sudo -u dev git push origin main', /updates main/],
    ['behind command', 'command git push origin main', /updates main/],
    ['behind timeout', 'timeout 30 git push origin main', /updates main/],
    ['through a path to git', '/usr/bin/git push origin main', /updates main/],
    ['with git -C', 'git -C ../other push origin main', /updates main/],
    ['with git -c', 'git -c push.default=current push origin main', /updates main/],
    ['the matching refspec', 'git push origin :', /every matching branch, main included/],
    ['a forced matching refspec', 'git push origin +:', /every matching branch/],
    ['push.default set by -c', 'git -c push.default=matching push origin', /which this command overrides/],
    ['a push refspec set by -c', 'git -c remote.origin.push=HEAD:main push origin', /which this command overrides/],
    ['an upstream set by -c', 'git -c branch.dev.merge=refs/heads/main push', /which this command overrides/],
    ['a -c setting from a variable', 'git -c "$SETTING" push', /which this command overrides/],
    ['push configuration from --config-env', 'git --config-env=push.default=PUSH_DEFAULT push', /which this command overrides/],
    ['push configuration from GIT_CONFIG_* variables', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push origin', /which this command overrides/],
    ['push configuration exported before', 'export GIT_CONFIG_PARAMETERS="\'push.default\'=\'matching\'" && git push', /which this command overrides/],
    ['a merge commit API call into main', 'gh api repos/o/r/merges -f base=main -f head=feature', /merges into main/],
    ['a merge commit API call without a readable base', 'gh api repos/o/r/merges --input body.json', /no base this guard can read/],
    ['a GraphQL merge without a pull request id', 'gh api graphql -f query="mutation { mergePullRequest(input: $input) { clientMutationId } }"', /no pull request id/],
    ['a push from an unknown directory', 'cd ~ && git push', /directory git push runs in is unknown/],
  ])('blocks %s', (_name, command, reason) => {
    const verdict = judge(command);
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toMatch(reason);
    expect(verdict.reason).toMatch(/dev included, stay allowed\.$/);
  });

  it.each([
    ['a push to a feature branch', 'git push origin 20-x'],
    ['a refspec onto a feature branch', 'git push origin HEAD:feature'],
    ['a push to dev', 'git push origin HEAD:dev'],
    ['a branch whose name starts with main', 'git push origin maintenance mainline'],
    ['an upstream setting push', 'git push -u origin 20-control-center-s4'],
    ['a refspec with unrelated -c settings', 'git -c push.default=matching -c user.name=x push origin dev'],
    ['tags only', 'git push --tags'],
    ['git log main', 'git log main'],
    ['git fetch origin main', 'git fetch origin main'],
    ['git pull origin main', 'git pull origin main'],
    ['git merge main', 'git merge main'],
    ['gh pr view', 'gh pr view 12 --json baseRefName'],
    ['gh pr create against main', 'gh pr create --base main --title x --body y'],
    ['gh pr merge --disable-auto', 'gh pr merge 12 --disable-auto'],
    ['the merged check of the REST API', 'gh api repos/o/r/pulls/5/merge'],
    ['a merge commit API call into dev', 'gh api repos/o/r/merges -f base=dev -f head=feature'],
    ['a quoted mention', 'echo "git push origin main"'],
    ['a commit message', 'git commit -m "gh pr merge 12 into main"'],
    ['a comment', '# git push origin main\necho ok'],
    ['a here-document', 'cat <<EOF > notes.md\ngit push origin main\nEOF\necho ok'],
    ['a chain of feature pushes with prefixes', 'env A=1 git status && sudo git push origin HEAD:feature; git -C sub push origin x:y'],
  ])('allows %s without any lookup', (_name, command) => {
    expect(judgeCommand(command, { cwd })).toEqual({ decision: 'allow' });
  });

  it('splits PowerShell chains', () => {
    expect(judge('git status; git push origin main', undefined, 'powershell').decision).toBe('block');
    expect(judge('pwsh -Command "git push origin main"').decision).toBe('block');
    expect(judge('git push origin `\n  HEAD:feature', undefined, 'powershell')).toEqual({ decision: 'allow' });
  });

  it('asks for the current branch of a push without a refspec and decides by branch and upstream', () => {
    expect(judgeCommand('git -C sub push', { cwd })).toEqual({ decision: 'need', needs: [{ fact: 'branch', dir: '/work/repo/sub' }, { fact: 'pushConfig', dir: '/work/repo/sub' }] });
    expect(judge('git push', onBranch('main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/on main tracking main pushes to main/) });
    expect(judge('git push origin', onBranch('main'))).toMatchObject({ decision: 'block' });
    expect(judge('git push -u', onBranch('feature', 'main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/on feature tracking main/) });
    expect(judge('git push', onBranch('feature'))).toEqual({ decision: 'allow' });
    expect(judge('git push', onBranch(null, null))).toEqual({ decision: 'allow' });
    expect(judge('git push origin HEAD', onBranch('main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/current branch main/) });
    expect(judge('git push origin HEAD', onBranch('feature', 'main'))).toEqual({ decision: 'allow' });
  });

  it('reads the push configuration of a push without a refspec and blocks what can reach main', () => {
    expect(judge('git push origin', onBranch('dev', 'dev', { pushDefault: 'matching' }))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/push.default=matching/) });
    expect(judge('git push origin', onBranch('dev', 'dev', { mirror: true }))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/mirrors every branch/) });
    expect(judge('git push', onBranch('dev', 'dev', { refspecs: ['HEAD:main'] }))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/configured refspec HEAD:main, which updates main/) });
    expect(judge('git push', onBranch('dev', 'dev', { refspecs: ['refs/heads/*:refs/heads/*'] }))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/can update main/) });
    expect(judge('git push', onBranch('dev', 'dev', { refspecs: [':'] }))).toMatchObject({ decision: 'block' });
    expect(judge('git push', onBranch('dev', 'dev', { pushDefault: 'current', refspecs: ['HEAD', 'dev:dev'] }))).toEqual({ decision: 'allow' });
    expect(judge('git push', onBranch('main', 'main', { refspecs: ['HEAD'] }))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/on main tracking main/) });
  });

  it('does not trust the branch read before the command when the command can change it first', () => {
    for (const command of ['git checkout main && git push', 'git switch main; git push origin HEAD', 'bash -c "git branch -u origin/main" && git push']) {
      expect(judgeCommand(command, { cwd })).toMatchObject({ decision: 'block', reason: expect.stringMatching(/can change the current branch/) });
    }
    // A push naming its target needs no branch, and a push before the switch reads it.
    expect(judgeCommand('git checkout -b feature && git push -u origin feature', { cwd })).toEqual({ decision: 'allow' });
    expect(judgeCommand('git push && git checkout main', { cwd }).decision).toBe('need');
  });

  it('asks for the base of a merged pull request and blocks only main', () => {
    expect(judgeCommand('gh pr merge --admin -R o/r 12 --squash', { cwd })).toEqual({
      decision: 'need', needs: [{ fact: 'pullBase', dir: cwd, repo: 'o/r', selector: '12' }],
    });
    expect(judgeCommand('gh pr merge --auto --squash', { cwd })).toEqual({ decision: 'need', needs: [{ fact: 'pullBase', dir: cwd }] });
    expect(judge('gh pr merge 12', withBase('main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/merge PR 12 into its base main/) });
    expect(judge('gh pr merge --auto --squash', withBase('main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/pull request of the current branch/) });
    expect(judge('gh pr merge 12 --squash --delete-branch', withBase('dev'))).toEqual({ decision: 'allow' });
    expect(judge('gh pr merge "$PR"').decision).toBe('block');
  });

  it('asks for the base of REST and GraphQL merges', () => {
    expect(judgeCommand('gh api -X PUT repos/o/r/pulls/5/merge', { cwd })).toEqual({
      decision: 'need', needs: [{ fact: 'pullBase', dir: cwd, repo: 'o/r', selector: '5' }],
    });
    expect(judgeCommand('gh api repos/{owner}/{repo}/pulls/5/merge -f merge_method=squash', { cwd })).toEqual({
      decision: 'need', needs: [{ fact: 'pullBase', dir: cwd, selector: '5' }],
    });
    expect(judge('gh api --method=PUT /repos/o/r/pulls/5/merge', withBase('main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/merges PR 5 into its base main/) });
    expect(judge('gh api -X PUT repos/o/r/pulls/5/merge', withBase('dev'))).toEqual({ decision: 'allow' });

    const literal = 'gh api graphql -f query=\'mutation { mergePullRequest(input: { pullRequestId: "PR_kw1" }) { clientMutationId } }\'';
    expect(judgeCommand(literal, { cwd })).toEqual({ decision: 'need', needs: [{ fact: 'pullBaseById', id: 'PR_kw1' }] });
    expect(judge(literal, withBase('main'))).toMatchObject({ decision: 'block', reason: expect.stringMatching(/GraphQL merge/) });
    const variable = 'gh api graphql -f query=\'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }\' -f id=PR_kw2';
    expect(judgeCommand(variable, { cwd })).toEqual({ decision: 'need', needs: [{ fact: 'pullBaseById', id: 'PR_kw2' }] });
    expect(judge(variable, withBase('dev'))).toEqual({ decision: 'allow' });
  });

  it('blocks with the lookup error when a fact cannot be read', () => {
    const verdict = judge('gh pr merge 12', () => ({ error: 'HTTP 502: Bad Gateway' }));
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toMatch(/lookup for gh pr merge of PR 12 failed, so its target may be main: HTTP 502: Bad Gateway/);
    expect(judge('git push', () => ({ error: 'not a git repository' })).reason).toMatch(/lookup for git push failed.*not a git repository/);
  });

  it('blocks without a lookup when one part of a chain is known to target main', () => {
    expect(judgeCommand('gh pr merge 12 && git push origin main', { cwd }).decision).toBe('block');
  });
});

describe('the tool_call hook', () => {
  const loadHook = ({ kind = async () => 'worker', runLookup = vi.fn() } = {}) => {
    const handlers = {};
    const pi = { registerTool() {}, on: (name, handler) => { handlers[name] = handler; }, getActiveTools: () => [], setActiveTools() {} };
    const sessionKind = vi.fn(kind);
    createOrchestrationExtension({ call: async () => ({}), sessionKind, sessionProfile: () => undefined }, { runLookup }).factory(pi);
    const call = (command, toolName = 'bash') => handlers.tool_call(
      { type: 'tool_call', toolCallId: 'call-1', toolName, input: { command } },
      { cwd, sessionManager: {} },
    );
    return { call, sessionKind, runLookup };
  };

  it('blocks a worker\'s push to main with a reason and lets an unmarked session push', async () => {
    const worker = loadHook();
    expect(await worker.call('git push origin HEAD:main')).toEqual({ block: true, reason: expect.stringMatching(/^Merge guard: git push HEAD:main updates main\./) });
    expect(await worker.call('git push origin HEAD:main', 'powershell')).toMatchObject({ block: true });
    expect(await worker.call('git push origin HEAD:feature')).toBeUndefined();
    const owner = loadHook({ kind: async () => 'unmarked' });
    expect(await owner.call('git push origin HEAD:main')).toBeUndefined();
    expect(await loadHook({ kind: async () => 'orchestrator' }).call('git push origin main')).toMatchObject({ block: true });
  });

  it('reads neither the session kind nor any fact for an ordinary command', async () => {
    const worker = loadHook();
    expect(await worker.call('git status && bun test')).toBeUndefined();
    expect(worker.sessionKind).not.toHaveBeenCalled();
    expect(worker.runLookup).not.toHaveBeenCalled();
  });

  it('guards when the session kind cannot be read, but only merges and pushes into main', async () => {
    const unknown = loadHook({ kind: async () => { throw new Error('settings unreadable'); } });
    expect(await unknown.call('git push origin main')).toMatchObject({ block: true });
    expect(await unknown.call('git push origin feature')).toBeUndefined();
  });

  it('looks up the base of a pull request in the session directory and blocks only main', async () => {
    const runLookup = vi.fn(async () => ({ code: 0, stdout: 'dev\n', stderr: '' }));
    const worker = loadHook({ runLookup });
    expect(await worker.call('gh pr merge 12 --squash')).toBeUndefined();
    expect(runLookup).toHaveBeenCalledWith('gh', ['pr', 'view', '12', '--json', 'baseRefName', '--jq', '.baseRefName'], cwd);
    runLookup.mockResolvedValue({ code: 0, stdout: 'main\n', stderr: '' });
    expect(await worker.call('gh pr merge 12 --squash')).toEqual({ block: true, reason: expect.stringMatching(/^Merge guard: gh pr merge would merge PR 12 into its base main\./) });
  });

  it('blocks with the lookup error when the base cannot be read', async () => {
    const failed = loadHook({ runLookup: async () => ({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 12.\n' }) });
    expect((await failed.call('gh pr merge 12')).reason).toMatch(/failed, so its target may be main: GraphQL: Could not resolve to a PullRequest with the number of 12\./);
    const timedOut = loadHook({ runLookup: async () => ({ code: 'timed out', stdout: '', stderr: '' }) });
    expect((await timedOut.call('gh pr merge 12')).reason).toMatch(/target may be main: timed out/);
    const thrown = loadHook({ runLookup: async () => { throw new Error('spawn gh ENOENT'); } });
    expect((await thrown.call('gh pr merge 12')).reason).toMatch(/spawn gh ENOENT/);
  });

  it('reads the current branch and its upstream for a push without a refspec', async () => {
    const repo = (branch, upstream) => async (_file, args) => {
      if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' };
      return args[0] === 'symbolic-ref'
        ? { code: branch ? 0 : 1, stdout: branch ? `${branch}\n` : '', stderr: '' }
        : { code: 0, stdout: upstream ? `refs/heads/${upstream}\n` : '\n', stderr: '' };
    };
    expect(await loadHook({ runLookup: repo('main', 'main') }).call('git push')).toMatchObject({ block: true });
    expect(await loadHook({ runLookup: repo('feature', 'main') }).call('git push')).toMatchObject({ block: true });
    expect(await loadHook({ runLookup: repo('feature', 'feature') }).call('git push')).toBeUndefined();
    expect(await loadHook({ runLookup: repo('feature', null) }).call('git push')).toBeUndefined();
    expect(await loadHook({ runLookup: repo(null, null) }).call('git push')).toBeUndefined();
  });
});

// Sol review of #194, round 1: the same hook with its real lookups, in a clone
// of a local bare repository, next to what git itself would update. The clone
// is on dev tracking origin/dev, and its main is one commit ahead of the
// remote's, so every push that reaches main would change it.
describe('the tool_call hook against real git', () => {
  let root;
  let clone;
  const previous = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  const git = (...args) => execFileSync('git', args, { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // What `git push --dry-run` reports for the same command: does it update main?
  const gitUpdatesMain = (command) => {
    const args = command.split(' ').slice(1);
    args.splice(args.indexOf('push') + 1, 0, '--dry-run', '--porcelain');
    return git(...args).split('\n').some((line) => /^[^=!]\t[^\t]*:refs\/heads\/main\t/.test(line));
  };
  const call = (command) => {
    const handlers = {};
    const pi = { registerTool() {}, on: (name, handler) => { handlers[name] = handler; }, getActiveTools: () => [], setActiveTools() {} };
    createOrchestrationExtension({ call: async () => ({}), sessionKind: async () => 'worker', sessionProfile: () => undefined }).factory(pi);
    return handlers.tool_call({ type: 'tool_call', toolCallId: 'call-1', toolName: 'bash', input: { command } }, { cwd: clone, sessionManager: {} });
  };

  beforeAll(() => {
    // Only the clone's own configuration counts, not the host's.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    root = mkdtempSync(join(tmpdir(), 'pichamber-merge-guard-git-'));
    clone = join(root, 'clone');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'remote.git')]);
    execFileSync('git', ['clone', '-q', join(root, 'remote.git'), clone], { stdio: 'ignore' });
    git('config', 'user.email', 'guard@example.com');
    git('config', 'user.name', 'Guard');
    git('commit', '-q', '--allow-empty', '-m', 'initial');
    git('push', '-q', 'origin', 'main', 'main:dev');
    git('commit', '-q', '--allow-empty', '-m', 'ahead of the remote main');
    git('checkout', '-q', '-b', 'dev', '--track', 'origin/dev');
    git('commit', '-q', '--allow-empty', '-m', 'dev work');
    git('branch', 'feature');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, name] of [['global', 'GIT_CONFIG_GLOBAL'], ['nosystem', 'GIT_CONFIG_NOSYSTEM']]) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
  });

  it.each([
    'git push origin main',
    'git push origin :',
    'git -c push.default=matching push origin',
    'git -c remote.origin.push=HEAD:main push origin',
  ])('blocks %s, which git would push to main', async (command) => {
    expect(gitUpdatesMain(command)).toBe(true);
    expect(await call(command)).toMatchObject({ block: true, reason: expect.stringMatching(/^Merge guard: /) });
  });

  it.each([
    ['push.default', 'matching'],
    ['remote.origin.push', 'HEAD:main'],
    ['remote.origin.mirror', 'true'],
  ])('blocks a push without a refspec when the clone sets %s to %s', async (key, value) => {
    git('config', key, value);
    try {
      expect(await call('git push origin')).toMatchObject({ block: true });
      if (key !== 'remote.origin.mirror') expect(gitUpdatesMain('git push origin')).toBe(true);
    } finally {
      git('config', '--unset', key);
    }
  });

  it.each([
    'git push',
    'git push origin',
    'git push origin dev',
    'git push origin HEAD:dev',
    'git push -u origin feature',
  ])('allows %s, which git would not push to main', async (command) => {
    expect(gitUpdatesMain(command)).toBe(false);
    expect(await call(command)).toBeUndefined();
  });
});
