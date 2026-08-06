# Clitheroe Airport Transfer — effective-engine

A minimal Node.js + Express application for the Clitheroe Airport Transfer service. This repository contains the project manifest, a Dockerfile and CI config; the application entrypoint should be `server.js` (see example below).

Status
------
- Minimal scaffold present: package.json, Dockerfile, cloudbuild.yaml.
- This app uses a third-party booking system for bookings and dispatch. The app is currently a lightweight API around that booking system and can be extended to integrate more tightly as needed.

Third‑party booking systems
---------------------------
- Google Cloud project used for hosting / integrations (console):
  https://console.cloud.google.com/home/dashboard?project=fresh-span-487121-q7
- TaxiWebBooker (booking/dispatch portal):
  https://portal.taxiwebbooker.com/groups/63b7fd607b4a3b1fcd974745/dispatchpanel

Quickstart (local)
-------------------
1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

By default the app listens on PORT 8080 (or the value of the PORT environment variable).

Docker (local)
---------------
Build and run the container locally:

```bash
docker build -t effective-engine .
docker run -p 8080:8080 effective-engine
```

Cloud Build (GCP)
------------------
cloudbuild.yaml will build and push the image to gcr.io using the environment variables $PROJECT_ID and $COMMIT_SHA. Example using gcloud:

```bash
gcloud builds submit --config cloudbuild.yaml --project=YOUR_PROJECT_ID .
```

API (example)
-------------
- GET /health — simple health check. Example:

```bash
curl http://localhost:8080/health
# { "status": "ok" }
```

- GET / — root placeholder response.

Notes on integration
--------------------
- The repository currently references `server.js` as the app entrypoint in package.json. Ensure `server.js` is present in the repo root. A minimal example you can use:

```javascript
const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('Clitheroe Airport Transfer API'));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```

- Configuration: add environment variables or configuration files for any credentials or API keys required by TaxiWebBooker or your Google Cloud integrations. Example env names to consider:
  - TAXIWEBBOOKER_URL — the base URL for the TaxiWebBooker portal (if using their API)
  - TAXIWEBBOOKER_API_KEY — API key/token for the booking portal (if available)
  - GOOGLE_PROJECT_ID — GCP project id used by cloudbuild and deployments

What I changed
--------------
- Added README.md to document the project, how to run it locally, Docker and Cloud Build usage, and the third-party booking system URLs you provided.

Next steps I can do for you
---------------------------
- Commit the minimal `server.js` file into the repo so the app runs immediately.
- Add basic route scaffolding (`/quotes`, `/bookings`, `/drivers`) that proxies or links to the TaxiWebBooker APIs.
- Add a short CONTRIBUTING.md or Infrastructure notes for deployments to your Google Cloud project.

If you want me to add the minimal `server.js` now and push it to the repo, say "Yes — add server.js" and I will commit it.