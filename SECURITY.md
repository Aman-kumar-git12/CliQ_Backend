# Security and operations

## Secrets

Secrets live only in the host's environment settings (Render for this API, the agent's host, Vercel
for the frontend's public `VITE_*` values) and in local `.env` files, which git ignores. Never commit
them, paste them into issues, or put them in `VITE_*` variables (those are public).

The MongoDB password that was once committed is still in git history: change it in MongoDB Atlas
(Database Access > edit user > new password) and update `DATABASE_URL` everywhere it is set.

## Rotating secrets (every 6–12 months, and at once after any leak)

| Secret                                        | How to rotate without logging everyone out                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET_KEY`                              | Set the new value, and the old one as `JWT_SECRET_KEY_PREVIOUS`. Remove `JWT_SECRET_KEY_PREVIOUS` after 15 minutes (the access-token lifetime).                                       |
| `AGENT_INTERNAL_KEY`                          | On the agent: new value in `AGENT_INTERNAL_KEY`, old one in `AGENT_INTERNAL_KEY_PREVIOUS`. Then set the new value on this API. Then remove the agent's `AGENT_INTERNAL_KEY_PREVIOUS`. |
| `GROQ_API_KEY`                                | Create a new key in the Groq console, set it on the agent, delete the old key.                                                                                                        |
| `DATABASE_URL` password                       | Atlas > Database Access > edit user. Update the API and the agent right after.                                                                                                        |
| Cloudinary, Brevo (`SMTP_PASS`), Google OAuth | Create a new key in the provider's console, set it, then delete the old one.                                                                                                          |

## Environments

Use a separate database for anything that isn't production: a second Atlas cluster (or database
name) for staging, `docker compose up` for local work, and the in-memory database for tests.
Point a staging deploy of the API at the staging database and a staging Vercel preview at that API.

## Deployment

`.github/workflows/ci.yml` runs lint, format check and tests, builds the Docker image, and on `main`
triggers the Render deploy hook (repository secret `RENDER_DEPLOY_HOOK_URL`). With that in place,
turn off Render's auto-deploy so only commits that passed CI go live, and protect `main` in GitHub
(Settings > Branches): require a pull request and the CI checks to pass.

After a schema change that adds indexes (`prisma/schema.prisma`), run once against each database:

```bash
DATABASE_URL="<that database>" npx prisma db push
```

## Monitoring

- Errors: set `SENTRY_DSN` on the API and agent, and `VITE_SENTRY_DSN` on the frontend.
- Uptime: point a monitor (e.g. UptimeRobot, Better Stack) at `/api/health/ready` on the API and
  `/api/health` on the agent, alerting by email.
- Logs: production logs are JSON lines; search by `requestId` to follow one request through the API
  and the agent.

## Reporting a vulnerability

Email the maintainers privately instead of opening a public issue.
