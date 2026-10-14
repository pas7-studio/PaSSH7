# Security policy

PaSSH7 is experimental and has **not** completed a security audit. Never file genuine passwords, private keys, vault files, or tokens in a public issue.

Please report suspected vulnerabilities privately using GitHub's **Report a vulnerability** feature (Security Advisories) for this repository. Do not publish proof-of-concept exploits before maintainers can investigate.

Current boundaries: the encrypted vault implementation is local only. No SSH client, desktop app, key agent, or MCP integration ships in this milestone. An unlocked workstation or privileged malware can still obtain secrets.
