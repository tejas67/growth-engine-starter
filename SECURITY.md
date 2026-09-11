# Distribution boundary

Only source, dependency manifests, generic prompts, and synthetic examples belong in this repository. Keep instance settings, credentials, data exports, captured API payloads, attachments, reports, CLI authentication, and backups out of Git.

`npm run export` checks committed filenames and common credential patterns, then uses `git archive` to omit Git history and ignored local files. It refuses uncommitted source changes, unknown distribution paths, symlinks, oversized files, and detected key material. It is a basic guard, not a comprehensive secret detector. Scan with a dedicated tool such as [Gitleaks](https://github.com/gitleaks/gitleaks) before wider sharing.

If a real key enters Git history, revoke/rotate it with its provider. Removing the current file or making the repository private does not undo an earlier disclosure. Inspect every commit in a repository before sharing it.

Use this app on your own computer. There is one named owner account, a password hash, signed sessions, login throttling, and same-origin form protection. Exposing it on the internet requires separate deployment/authentication review; the included launcher deliberately binds to loopback.

AI output and scraped text are untrusted. Provider tools are disabled, outputs are parsed and validated, drafts require human review, and dispatch rechecks approval integrity and suppression. Your business profile can still contain mistaken claims: review the actual copy. HeyReach's campaign controls the sequence after enrollment.

Report security issues privately to the repository owner without posting credentials, production payloads, or prospect data in an issue.
