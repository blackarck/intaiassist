# Contributing

Thanks for helping. This is a small, largely AI-assisted open source project, so bug reports, fixes, tests and docs are all welcome.

- **Found a bug or rough edge?** Open an [issue](https://github.com/blackarck/intaiassist/issues) with what you did, what you expected and what happened. Never paste real interview transcripts, candidate details, API keys or tokens.
- **Security problem?** Do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Want to change something?** For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setting up

Follow "Quick start" in the [README](README.md). Local dev mode needs no accounts and never creates a real meeting bot.

## Before you open a pull request

```bash
cd backend && npm test && npm run typecheck
cd web && npm test && npm run typecheck && npm run build
```

- Keep changes focused, and add or update a test when behaviour changes.
- Never commit secrets (`.env` files are git-ignored), real transcripts or personal data.
- Interview content is personal data: do not log it, and keep it out of AI run logs.

By contributing you agree that your work is licensed under the [Apache License 2.0](LICENSE), the same as the project.
