# Office voice gateway

Persistent Node service for the Seeger Weiss Office voice companion. Uses AWS Nova 2 Sonic bidirectional streaming, with credentials kept on the server. The platform issues short-lived authenticated grants; WebSocket clients send the grant in the first message, never in the URL.

```sh
npm ci
# Configure .env from .env.example with the intended AWS account and shared secret.
node --env-file=.env server.mjs
```

`npm start` uses environment variables already present in the process. `npm test` runs offline protocol/audio tests plus real local WebSocket authorization and acknowledgment tests. No test invokes AWS.

The platform independently defaults `OFFICE_VOICE_ENABLED` to off. Starting this service or configuring its secret does not enable the Office control. Enable it in the platform server only for a deliberate staging test, then retain the off default until authenticated speech and task-control acceptance checks pass.

See [Office conversation and voice](../../docs/office-conversation-and-voice.md) for platform integration, deployment limits, expected UX, environment variables, and validation requirements. `/health` confirms only that this process runs; it does not verify AWS credentials or model access.
