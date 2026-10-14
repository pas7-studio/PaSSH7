# PaSSH7 self-hosted CI setup

**Policy: no GitHub-hosted runners.** The workflow only targets `[self-hosted, passh7, passh7-linux]` or `[self-hosted, passh7, passh7-windows]`.

## Security gate for a public repository

Public pull requests can contain arbitrary code. **Never run unreviewed pull request code on a persistent self-hosted runner**, particularly one that can reach private network infrastructure. For now, CI triggers only on a push to trusted `main` or explicit `workflow_dispatch`. Review/merge code only after manual local validation on an isolated machine until an ephemeral PR runner is ready. Add GitHub branch protection and CODEOWNERS before allowing community contributions.

Do not install the runner on hosts containing SSH vaults, privileged Docker sockets, production deploy credentials, personal work files, or other secrets. Use a dedicated low-privilege machine or disposable VM with restricted outbound network access. Prefer **ephemeral** runners created per job; destroy and recreate the environment after each run. Never allow PRs from untrusted forks to execute here.

## Linux runner

1. Create a dedicated non-admin account on a dedicated VM.
2. In GitHub repo: Settings -> Actions -> Runners -> New self-hosted runner -> Linux x64.
3. Run GitHub's **current** installer and registration commands *on the dedicated VM*, with runner labels `self-hosted,passh7,passh7-linux`. Generate registration tokens in the GitHub UI; do not put these in code or chat.
4. Give the user no `sudo`, no Docker group and no access to host SSH keys.
5. Install a trusted Rust stable toolchain with rustfmt/clippy. Make the runner disposable if possible.
6. Keep it offline until ready to run reviewed commits.

## Windows runner

1. Use a separate Windows VM, not the personal desktop containing vault secrets.
2. Register via repo Settings -> Actions -> Runners with labels `self-hosted,passh7,passh7-windows`.
3. Use a standard, low-privilege service identity with Rust stable and required MSVC build tools.
4. Disable untrusted inbound connections. No production keys, secrets or persistent credentials.

## CI behavior

Both Linux and Windows jobs execute fmt, clippy and tests. If only one runner exists, the other job stays queued. **Do not** replace its label with `ubuntu-latest` or `windows-latest`. The project intentionally accepts an unrun CI job instead of consuming GitHub-hosted minutes.

## Work still needed

- Provision dedicated runner(s) in the user's infrastructure (requires machine access).
- Add ephemeral runner lifecycle and optional reviewed-PR test workflow.
- Review repository/organization Actions settings and enforce appropriate approvals.
- Confirm actions billing: self-hosted runner execution generally avoids standard hosted runner minutes, but other Actions features and underlying infrastructure may still have costs depending on plan.
