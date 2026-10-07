# finance-79venture

Finance web app for 79 Ventures, served at `finance.79venture.com`.

## Structure

- `public/` — the site. `public/index.html` is the home page.
- `server.js` — small static server with no dependencies. Serves `public/` and exposes `/health`.

## Run locally

```
npm start
```

Then open http://localhost:3000.

## Deploy

Railway deploys the `main` branch automatically and runs `npm start`. The server reads the port from `PORT`, which Railway sets.

Secrets (API keys, passwords) go in Railway Variables, never in this repo.

## Working on this repo

Work on a separate branch and open a pull request. Anything merged to `main` goes live.
