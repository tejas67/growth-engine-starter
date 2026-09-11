# Architecture

The host Node process runs the SvelteKit dashboard and a pg-boss worker. Docker runs a separate PostgreSQL database bound to loopback. CLI AI providers execute on the host so they can use the installation owner's login.

```text
Settings ── local configuration + credential files
Sources ── manual import / Unipile discovery ── PostgreSQL
                                           │
                   fit score → optional research → draft + copy checks
                                                        │
                                                   human review
                                                        │
                                         guarded HeyReach handoff
                                                        │
                                confirmed outcomes entered in Sources
```

`config/local.ts` validates and atomically persists the business, AI, and account configuration. It reads settings on demand. `.env` holds process-level database/login settings loaded at startup. Browser loaders expose configuration and credential-presence booleans, never API keys.

`src/clients/ai.ts` selects the provider and usage-limit fallback. CLI runners disable tools/customizations and pass an allowlist of environment variables. API runners keep cloud keys on fixed vendor endpoints; a compatible endpoint uses its separate key. All generated objects pass schema checks, with copy checks before drafts enter review.

`src/standalone/data.ts` handles manual imports and fictional demo drafts. `is_demo` is immutable once set; database triggers and dispatch queries prevent demo sends. Manual imports have no invented engagement rows.

`dispatch_attempt` records a unique claim before each provider request. Accepted leads are marked queued with `enrolled_at`, without inventing a `sent_at` timestamp. An uncertain request cannot be automatically retried. Manually confirmed outcomes update Results separately.

The schema retains legacy tables for compatibility with the extracted pipeline. The private application bridge, email send lane, IMAP ingestion, and automatic HeyReach inbox polling are disabled. This edition can run without those systems.

Start with `npm run check` and `npm run test:integration`. The integration command creates its own uniquely named local database and removes only that database afterward. Never point integration tests at a live database.
