# Office conversation and voice

Local implementation, September 12, 2026. Applies to the real platform's Writer, Sheets, and Slides. It does not integrate MCO code.

## Working behavior

- While an Office task runs, **Add a direction while it works** accepts up to four pending directions (2,000 characters each). Clear removes directions that have not been applied.
- A direction applies at the next model/tool boundary. An operation already executing settles once. Operations that have not started are skipped, with explicit paired tool results. The model then replans with the user's direction and the original task context. Python scope, attachments, history, and the restoration point remain attached to the same run.
- Directions arriving during a text-only response also cause another turn before completion. Steering does not reset the total turn budget. Directions are visible in the chat when applied and included in conversation persistence.
- **Stop task** cancels model streaming and signals cooperative cancellation to the active tool. Earlier edits remain. Undo/review continues to use the existing Office behavior; stopping is not a rollback.
- **Voice** opens a separate Nova 2 Sonic conversation. It can submit a document task, change its directions, check its actual status, or stop it. The existing Office agent does the document inspection, research, and editing. Voice is not given arbitrary native editor or Python execution tools.
- Task status distinguishes running, stopping, completed, partial, stopped, failed, and idle. A submission acknowledgment is explicitly not a completion acknowledgment.
- Voice is available in Write, Ask, and Review. It preserves their existing tool permissions. Public Research mode has a separate approved-query boundary and does not offer voice.
- Mute disables microphone tracks and sends silent frames to preserve the connection. End voice releases microphone tracks, playback nodes, AudioWorklet, AudioContext, and WebSocket without cancelling the Office task. Changing the document, mode, or conversation resets voice scope.
- Playback is cleared when the user interrupts. Only finalized text enters the visible transcript. At seven minutes the client obtains a fresh authenticated grant and reconnects with a bounded transcript. There can be a brief audio gap; pending edits are never replayed on reconnection. Fresh speech is required before another task action.

## Boundaries

This is an interactive browser-owned Office agent, not a durable background job system. Keep the editor open while work runs. Closing the tab does not provide job recovery or guaranteed completion. A server operation already started may finish before its cancellation signal is honored.

The voice gateway is implemented with a real Bedrock bidirectional stream. **Live AWS speech has not been exercised in this local environment.** Voice defaults to disabled. The browser checks an authenticated availability RPC; the grant endpoint independently requires `OFFICE_VOICE_ENABLED=true`, a valid gateway URL and adequate signing secret. A hidden or disabled control cannot bypass this server gate. The flag is an administrator-controlled release decision, not an automatic gateway health check. There is no simulated voice or mock document execution in the production path. Test fixtures substitute the transport explicitly.

Voice task status includes bounded assistant prose and a structured result state, not hidden reasoning or a complete fresh document snapshot. Document-specific questions are delegated to the Office agent so they use its actual readers and source tools. Spoken answers are not a replacement for the cited written answer in the Office conversation.

## Runtime layout

| Location                                     | Responsibility                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/writer/packages/agent-core/src/loop.ts` | Safe steering boundaries, paired results, shared status, cancellation and run budget  |
| `src/office/shared/OfficeTaskControls.tsx`   | Compact shared controls, queued directions, microphone state, transcript              |
| `src/office/shared/voice-task-router.ts`     | Allowlisted task actions, fresh-utterance requirement, duplicate acknowledgment cache |
| `src/office/shared/voice-client.ts`          | Microphone, playback, interruption, renewal, cleanup                                  |
| `public/office-voice-capture.js`             | 16 kHz mono PCM AudioWorklet; resamples actual device sample rate                     |
| `src/lib/office/voice.functions.ts`          | Cognito-authenticated grant RPC with bounded app/mode/document input                  |
| `src/lib/office/voice-grant.server.ts`       | Server-only, 60-second HS256 grants; no AWS credentials in the browser                |
| `services/office-voice`                      | Persistent WebSocket gateway to Bedrock Nova 2 Sonic                                  |

Writer and Slides mount the shared controls in their assistant composers. Sheets passes the controls from the loop owner through ExcelShell into AiChatPanel. The surrounding vendored formatting is retained to keep the integration diff small.

## Local setup

The Office front end remains at `http://localhost:5176/office`, behind normal sign-in.

1. Generate a random signing secret of at least 32 bytes. Store the same value in the platform runtime and gateway environment. Never prefix it with `VITE_` or commit it.
2. In the platform's local `.env`, set `OFFICE_VOICE_PUBLIC_URL=ws://127.0.0.1:8091/voice` and `OFFICE_VOICE_JWT_SECRET`. For an intentional local or staging voice test, also set `OFFICE_VOICE_ENABLED=true`; keep it false/unset in other environments until the acceptance checks pass. Restart Vite when server environment changes. The repository's Vite wrapper reads `.env` explicitly. Deployed configuration belongs in the platform's approved runtime configuration/secret process; do not put signing material in build variables or commit it.
3. Copy `services/office-voice/.env.example` to `.env` **inside that service directory** and set the matching secret and the intended AWS profile/role. Verify that these credentials belong to the correct platform account; do not assume the machine's default account is correct.
4. In `services/office-voice`, run `npm ci`, then `node --env-file=.env server.mjs`. `GET http://127.0.0.1:8091/health` reports the service process's health without invoking AWS.
5. Sign in to Office, open a document, and select Voice. The gateway uses `amazon.nova-2-sonic-v1:0` in the configured `AWS_REGION` (default `us-east-1`). The runtime role needs `bedrock:InvokeModelWithBidirectionalStream` for that model and model availability in the selected region.

Use a persistent Node host for deployment, with TLS/WSS termination and explicit production origins. The main application's Lambda SSE route has a shorter request lifetime and is not a host for this WebSocket service. The gateway does not store audio or log tokens, document text, or transcripts.

The default gateway caps active sessions at 16, allows two per principal, bounds input queues/payloads, rejects unknown actions, and times out unacknowledged tools. Its consumed-grant and session-limit maps are process-local. Before running multiple replicas, use a shared expiry-aware grant-consumption and per-principal session store if global limits and global single-use admission are required. One process is the supported initial deployment shape.

## Verification

Run from the platform root:

```sh
npm test
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/@playwright/test/cli.js test --config playwright.office.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.discovery.config.ts
node node_modules/vite/bin/vite.js build
```

Run `npm test` inside `services/office-voice` for real loopback WebSocket/JWT tests and audio/protocol checks. Those tests use a local transport fixture, not AWS. Office browser tests exercise the production task loop, shared UI, and voice client with controlled audio/transport substitutes, alongside the real Writer edit engine and Mermaid renderer. They do not substitute for authenticated live speech and document tests against the intended testing account.

## AWS references

Protocol and lifecycle implementation were checked against [Nova 2 Sonic getting started](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-getting-started.html), [tool configuration](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-tool-configuration.html), [barge-in behavior](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-barge-in.html), and the [official Node WebSocket example](https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech/amazon-nova-2-sonic/sample-codes/websocket-nodejs).

Continue with `office-agent-reliability.md` for document-tool guarantees and `office-agent-upgrade-assessment-2026-09-12.md` for the broader roadmap. Durable job execution, production live-voice validation, and richer indexed document intelligence remain separate work.

### Historical local checks (before integration)

See [the integration handoff](discovery-office-integration.md) for the current combined branch's evidence and remaining staging requirements.

The completed local checks passed: 463 platform unit tests, 13 voice-gateway/audio/protocol tests, 17 Office browser tests, and 11 Discovery regression browser tests. TypeScript and the production Vite build passed. New/changed shared runtime modules passed targeted lint; the five vendored panel/shell files retain their original formatting and their six pre-existing hook warnings, with no new semantic lint findings. The generated public JavaScript contains no voice grant signing implementation or signing-secret environment lookup.

These are local checks with controlled transports where external services are involved. Authenticated live AWS speech, live document editing through voice, and production deployment remain to be validated in the intended platform account.
