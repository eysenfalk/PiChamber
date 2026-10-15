# 0018. Remote workers run on PiChamber servers on isolated VMs, federated by the laptop server; only the laptop reaches forges and internal systems

- Status: Proposed
- Date: 2026-10-15
- Waits for: the owner's go on the plan in the pull request for #207, and the live proof of its acceptance criteria on one of the owner's VMs

## Context

Issue #207: worker sessions run only on the owner's laptop, which gets overloaded. The owner has two Debian 13 VMs. They are isolated on purpose: the laptop reaches them only by SSH, they have internet access but no route into the internal network (internal GitLab, internal registries), and no port can be opened on them. Later targets are containers, microVMs, Kubernetes and bwrap. The owner settled the following in the unknowns walk of session `01a138e0` on 2026-10-14 (transcript `~/.pi/agent/sessions/--home-feysen-projects-private-gh-PiChamber--/2026-10-14T05-26-36-153Z_01a138e0-7379-703a-a50a-6c39f615cf6f.jsonl`, entry numbers are its line numbers) and in the orchestrator's brief of 2026-10-15:

- Only the laptop opens connections; a VM never calls back. A worker keeps running on its VM while the laptop is away, and on reconnect the laptop reads the real state (#8).
- Model credentials: one `/login` per VM (`auth.json` mode 600), nothing copied from the laptop; with API keys one limited key per VM (#8).
- A host carries a class field (`isolated`, later `connected`); only `isolated` exists for now (#8).
- D1, architecture b3: the laptop's PiChamber server federates full PiChamber servers on the VMs over `ssh -L` (#62, #63).
- D2: each VM is authoritative for its sessions, worker registry and host gate; the laptop keeps references (host and session id) and shows the last known state with its time when a VM is unreachable (#66, #67).
- D3: the worker on the VM does everything up to the finished pull or merge request; a deterministic relay on the laptop pushes, opens the draft, feeds condensed CI failures and new review comments back to the worker and marks it ready when CI is green and the review passed; a review agent runs on the VM for at most two rounds; auto merge is a switch per worker set by the owner or the orchestrator at start, default off (#80, #81).
- D4: PiChamber sets up and updates a VM over SSH, repeatable; the owner logs in to the model once through a terminal on the VM; a version drift updates the VM when no worker runs there (#84, #85).
- D5: tested first with PiChamber on GitHub, built from the start for GitHub, GitLab and internal environments through a forge interface with `gh` and `glab` adapters; the VM gets no forge token (#88, #93, #94).
- U6 (brief): the relay syncs on every worker report: push the branch, update the description from the worker's file, open the draft the first time.
- U9 (brief): internal packages and images reach a VM as a cache the laptop fetches and copies over SSH, never through `ssh -R`.

What the code has today (read on 2026-10-15 at `origin/dev` `b5d9dcff`): the Pi session daemon is a local process behind a private socket (`packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`); orchestration, its registry, the host gate, `worker_start` (`orchestration/worker-start.js`, branch from `origin/dev`), the pull request watch (`lib/pi/pr-watch-poller.js`, github.com only) and `worker_cleanup` (`lib/github/merge-lookup.js`) all live in that daemon or the local server. The UI already switches between PiChamber servers by base URL and token (`packages/ui/src/lib/desktopHosts.ts`), and `pichamber serve --api-only` with `pichamber startup enable` runs a headless server under systemd. Pi 1.1.0 ships `examples/extensions/ssh.ts`, which runs Pi locally and its tools over SSH.

Alternatives considered:

- **a, Pi on the laptop with tools over SSH:** the agent loop and the model login stay on the laptop, so a worker dies with the laptop. Contradicts two owner rules (#40, A1).
- **b2, only the session daemon on the VM behind a forwarded socket:** the daemon's private protocol would become a network boundary, every daemon call would cross SSH, and files, git and terminal served by the laptop server would show the laptop's file system (#57). Rejected by the owner (#62).
- **b1 alone, switching the UI to one VM server at a time:** no overview across hosts, and the laptop orchestrator cannot start or see VM workers (#57). It remains the first step inside b3 (#61).
- **`ssh -R` for internal registries:** gives the VM a path into internal systems through the laptop, which the isolation forbids (#94, U9).

## Decision

- **A VM is a host.** The laptop server keeps a host record per VM: id, label, SSH target, class (`isolated` only; `connected` is refused until its own story), the VM server's loopback port and its client token in the laptop's host secrets. One SSH ControlMaster per host carries every connection to it.
- **Only the laptop connects.** The laptop server, not Electron, opens every SSH connection, so web, desktop and phone through the laptop see the same hosts. It uses local forwards (`-L`) only: no remote forwards (`-R`), no agent forwarding, no X11, no forwarded laptop credentials or environment. A VM never receives a laptop credential, a forge token or a route into the internal network.
- **Each VM runs an unchanged PiChamber server** bound to loopback, started by systemd, with its own Pi login and its own token. Its daemon is authoritative for its sessions, worker registry, limit and host gate. The laptop stores references `{ host, sessionId }` and reads state from the VM; on reconnect the VM's state wins, and while a VM is unreachable the laptop shows the last known state with its time.
- **The laptop federates through a host-scoped proxy.** The laptop server serves each host's API under a host-scoped path, injects the VM token server-side and never hands it to a client. The UI treats a host as a runtime it switches to, so every client of the laptop reaches every VM.
- **The orchestrator starts workers on a host.** `session_spawn` and `worker_start` take an optional `host`. The laptop daemon hands the start to the VM server, whose daemon books and runs the worker under its own limit and gate; the laptop's registry keeps the reference, and the digest and `session_list` show remote workers with their host and the time they were last seen.
- **Code reaches a VM through a relay repository.** On the VM each project has a bare relay repository and a clone whose `origin` is that relay repository, so `worker_start` keeps branching from `origin/dev`. The laptop pushes the base branch into the relay repository before a start and fetches worker branches from it. The VM has no forge remote.
- **The relay is deterministic code on the laptop, behind a forge interface.** The interface covers finding, creating as draft, updating the description of, reading checks and failed job excerpts of, reading review comments of, marking ready, enabling auto merge for and proving the merge of a pull or merge request. It has a `gh` and a `glab` adapter from the start; the existing GitHub pull request watch and merge lookup move behind it. On every report of a remote worker the relay fetches its branch, pushes it, opens the draft the first time and updates the description from a file the worker keeps in a relay directory outside the worktree. It hands CI failures and new review comments back to the worker as condensed messages, marks the request ready when CI is green and the review worker passed it, and enables auto merge only when the worker's switch says so (default off). It runs no model.
- **Internal dependencies reach a VM as a cache.** The laptop fetches the packages and images a project needs and copies them over SSH; the VM installs from that cache.
- **Setup and update are PiChamber's job.** Adding a host checks Debian 13, installs the laptop's exact PiChamber and Pi version, writes the systemd unit, creates the token and the tunnel, and runs the isolation check; it can run again at any time. The owner logs in to the model once through a terminal on the VM. A version drift is updated when no worker runs on that VM.
- **The isolation is checked, not assumed.** An isolation check runs at setup and on demand: the configured internal endpoints are unreachable from the VM, the VM holds no forge token, and the laptop's SSH configuration for the host allows only local forwards.

## Consequences

- The heavy work (agent loop, tools, builds, tests) leaves the laptop, and a worker keeps running while the laptop sleeps. Publishing, CI feedback and review feedback stop while the laptop is offline and continue on reconnect; a `connected` host class could carry that later.
- A VM server is a normal PiChamber server, so the VM side needs little new code and stays testable on its own; the new code sits in the laptop server (hosts, proxy, relay, cache, setup) and the orchestration's host parameter.
- Version drift between laptop and VM breaks the federation, so setup must pin and update versions.
- Workers on a VM cannot use `gh` or `glab`; their instructions say so, and anything a worker would publish goes through the relay.
- The forge interface is a second implementation for GitLab from the start, with its own tests and a live proof on a real GitLab project.
- The VM's token and the SSH target are new secrets of the laptop server; they stay in the host secrets and are never logged or sent to a client.

## Revisit when

A second kind of target (local bwrap or podman, containers, microVMs, Kubernetes) is added, which is when the host abstraction gets its second implementation; a `connected` host class is wanted; Pi runs sessions in separate processes or gains remote execution of its own; or the owner's network rules change so that a VM may reach internal systems.
