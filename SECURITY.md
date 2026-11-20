# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
"Report a vulnerability" button on the repository's Security tab, and include steps to reproduce.
We aim to reply within a few days.

## Running this project safely

- Keep every secret in `.env` (git-ignored) or a secret manager such as Key Vault. Never commit one.
- Set `INTAKE_TOKEN` to a long random value (`openssl rand -hex 32`); the backend refuses a short one in production.
- Never run with `DEV_AUTH=1` or `VITE_DEV_USER` outside your own machine (the backend refuses it with `NODE_ENV=production`).
- Keep the backend reachable only through the reverse proxy, as `deploy/docker-compose.yml` does.
