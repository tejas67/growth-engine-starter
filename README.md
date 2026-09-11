# Growth Engine

Your own workspace for finding relevant prospects, drafting thoughtful outreach, reviewing every message, and handing approved leads to your LinkedIn campaign.

Configure it for **your business**. Bring your own AI account and optional integrations. Each installation has its own database, credentials, audience, and writing preferences.

## Start here

Requires **Node.js 22.12+ (22.x) or 24+**, npm, Git, and Docker Desktop (or Docker Engine with Compose). On Windows, use WSL2. Start Docker before launching the app.

Clone this repository or extract the source ZIP, open a terminal in that directory, then run:

```sh
npm ci
npm run setup
npm start
```

Open **http://localhost:3100**. Setup prints your generated dashboard password once; save it in your password manager. Sign in using the login name you chose.

1. **Settings:** enter your business, sender name, audience, specific offer, and any real evidence. Choose your AI provider. Save, then click **Test AI**.
2. **Sources:** try the demo, add individual prospects, import a CSV, or add relevant LinkedIn source accounts.
3. **Run the engine:** assess fit and generate drafts. Refresh Sources to see job progress.
4. **Review:** edit, approve, or skip. Approval does not enable sending.
5. When ready, connect your own HeyReach campaign in Settings, verify the sender and campaign configuration, and enable approved handoffs.

The demo uses fictional people and cannot send, even after you connect accounts or approve its drafts. It is an example of a workflow, not your business's recommended messaging.

## Choose your AI

| Option | Setup | Model field |
| --- | --- | --- |
| Demo | No account needed; load sample drafts in Sources | Unused |
| Codex | Install [Codex](https://learn.chatgpt.com/docs/auth), then run `codex login` on this computer | Blank uses the CLI default, or enter a model available to your account |
| Claude Code | Install [Claude Code](https://code.claude.com/docs/en/authentication), then run `claude auth login` | Blank uses the CLI default, or enter a supported model |
| OpenAI API | Enter your own OpenAI API key in Settings | Required: a model available through the Responses API |
| Anthropic API | Enter your own Anthropic API key in Settings | Required: a model available through the Messages API |
| Compatible API | Enter a local or hosted OpenAI-compatible base URL; supply that service's key if required | Required: an installed/available model supporting chat completions |

API usage is billed by the provider separately from a ChatGPT or Claude subscription. CLI modes use the login on the computer running the app; they do not copy authentication files into this repository or a container. Keep the CLIs current; the runners require their text-only isolation flags, including Codex `--ignore-user-config` and Claude Code `--safe-mode`.

Local servers may use HTTP on `localhost`, `127.0.0.1`, or `::1`. Remote endpoints require HTTPS. A local model needs to follow the JSON instructions; small models may produce drafts that are held for review.

Choose an optional fallback in Settings. It is used when the primary reports a usage/rate limit, with a one-hour cooldown. Content validation failures are held instead of sent to a different model. Provider and model are recorded with each draft. If no CLI model is specified, provenance says **CLI default**, not an inferred model name.

## Configure the offer, not just the logo

Your business profile drives both fit scoring and copy. Write a specific audience and an offer you can deliver. Include locations, roles, company types, and exclusions if they matter. Leave proof blank unless it is true. Preferences and extra banned phrases can be changed in Settings.

Generic prompt files live in `skills/`. There is no inherited business, customer list, geography, campaign, or sender account. The shared schema retains some legacy labels: P1 means ideal buyer, P2 possible buyer, P3 partner/influencer, and P4 public sector. Public-sector prospects are held out of automated outreach in this version.

Changing the business or HeyReach identity pauses sending and returns pending approvals to review. It cannot recall leads already accepted by HeyReach. Run one business per installation; changing a profile does not erase the installation's existing data.

## Bring your own sources

Manual prospects and CSV imports work without a collector. Supply a real LinkedIn person URL, name, headline, optional company, and at least 20 characters explaining why the offer might help. `examples/prospects.csv` documents the columns with a deliberately non-importable placeholder. The engine does not invent a like or comment for imported prospects.

For discovery, connect your own LinkedIn account to Unipile. Enter its DSN, API key, and account ID in Settings. **Check connected accounts** can show your account IDs. Add source person/company/showcase URLs in Sources, then enable discovery. Sources can be paused individually.

Optional Serper company verification and Apollo enrichment use your own credits. Without verification, drafts cannot claim an unverified employer. Daily limits and scheduling constants are in `config/index.ts`; no paid integration is required for manual prospect import and AI drafting.

## Sending and results

This standalone edition hands LinkedIn leads to **your HeyReach account**. It does not send email and does not require a separate private application.

Create a dedicated campaign in HeyReach. Configure the message step to use the `message` custom field and the invitation note to use `note`. Check the selected LinkedIn sender, schedule, limits, and any additional follow-ups. The campaign owns the sequence; the app cannot enforce its content or stop its follow-ups after enrollment. Enable **Let new leads resume a finished campaign** only if that is what you want.

The Review screen shows the exact sender verified with HeyReach. In Settings, explicitly confirm the campaign setup and enable handoffs. Only approved real drafts are eligible. Copy, approval hashes, suppression, frequency caps, and daily handoff caps are checked before dispatch.

**Accepted means queued in HeyReach, not delivered.** Review delivery and replies in HeyReach. Record confirmed outcomes in **Sources → Campaign handoffs** to update Results; timestamps reflect when you recorded the outcome. Automatic inbox synchronization is disabled in this edition. Replies recorded here pause that prospect in the app; pause or stop any remaining HeyReach campaign steps there too.

A lost or ambiguous API response is marked uncertain and never automatically retried. Check the lead in HeyReach and continue managing it there; do not import it as a new identity to force a resend. Pausing this app stops new handoffs. Pause the HeyReach campaign too if you need to stop already queued leads.

## Your data and credentials

- `.env`: generated local database password, dashboard password hash, and session secret.
- `.local/settings.json`: your business profile and account identifiers.
- `.local/secrets.json`: your API keys, readable only by your OS user by default. Values are not returned to the browser after saving.
- Docker volume: prospects, drafts, approvals, campaign handoffs, and outcomes.
- Your CLI's normal authentication store: your Codex or Claude login, managed by that CLI.

These local files and volumes are excluded from Git and source exports. The app and database bind to loopback by default. Filesystem permissions protect stored keys; they are not encrypted by this application. Use normal device encryption and backups.

Configured AI providers receive the profile/prospect context needed for a generation. Enabled research and outreach vendors receive the data necessary for those actions. A local installation does not mean third-party APIs receive no data. There is no telemetry or callback to the business this starter was extracted from.

## Day-to-day commands

```sh
npm start                    # Database, migrations, dashboard, and worker
npm run db:down              # Stop this installation's database; preserve its volume
npm run check                # Types, unit tests, dashboard tests, and production build
npm run test:integration     # Creates and removes a dedicated local test database
npm run export               # Source ZIP from a clean, reviewed Git commit
```

Ctrl+C stops the app and worker. Jobs only run while the app is open. The database persists between runs. To use another port on first setup, set `GROWTH_SETUP_APP_PORT` or `GROWTH_SETUP_DB_PORT`. For an existing local PostgreSQL installation, set `GROWTH_DATABASE_URL` in `.env`, then run `npm start -- --external-db`.

For automated setup, set `GROWTH_SETUP_USER` and `GROWTH_SETUP_PASSWORD` (at least 12 characters) and run `npm run setup -- --non-interactive`. Never commit a file containing those values.

Back up your own database locally with `docker compose exec -T db pg_dump -U growth -d growth_starter -Fc > .local/backup.dump`. Back up `.env` and `.local` securely as well. **A data backup is not a source distribution.**

## Sharing and development

This is a fresh source repository, not a fork carrying the original Git history. Fixtures are synthetic. Deployment configuration, databases, captured vendor responses, lead lists, account identifiers, and credentials from the original installation were excluded.

Keep it private for invited collaborators. A collaborator clones the code and runs setup to create their own installation; do not give them your `.env`, `.local`, database dump, or CLI login. `npm run export` produces `.local/growth-engine-starter.zip` using a source allowlist and a basic credential check. Use a dedicated secret scanner as well before publishing changes; automated scans are not a substitute for reviewing new data files.

No open-source license is included. Broader public redistribution should be decided by the repository owner.
