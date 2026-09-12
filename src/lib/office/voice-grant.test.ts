import { test } from "node:test";
import assert from "node:assert/strict";
import { officeVoiceEnabled, issueVoiceGrant } from "./voice-grant.server.ts";

const configured = {
  OFFICE_VOICE_PUBLIC_URL: "wss://voice.example.test/voice",
  OFFICE_VOICE_JWT_SECRET: "test-only-secret-material".repeat(2),
};
test("voice is off by default even when a gateway URL and secret are present", () => {
  assert.equal(officeVoiceEnabled({}), false);
  assert.equal(officeVoiceEnabled(configured), false);
  assert.equal(officeVoiceEnabled({ ...configured, OFFICE_VOICE_ENABLED: "false" }), false);
  assert.equal(officeVoiceEnabled({ ...configured, OFFICE_VOICE_ENABLED: "true" }), true);
});
test("voice requires a valid secure endpoint and adequate server signing material", () => {
  for (const url of [
    "http://voice.example.test",
    "ws://voice.example.test/voice",
    "wss://u:p@example.test/voice",
    "wss://example.test/voice?token=x",
    "not a url",
  ])
    assert.equal(
      officeVoiceEnabled({
        ...configured,
        OFFICE_VOICE_ENABLED: "true",
        OFFICE_VOICE_PUBLIC_URL: url,
      }),
      false,
    );
  assert.equal(
    officeVoiceEnabled({
      ...configured,
      OFFICE_VOICE_ENABLED: "true",
      OFFICE_VOICE_JWT_SECRET: "short",
    }),
    false,
  );
});
test("disabled voice cannot mint a grant even when called directly", async () => {
  const previous = process.env.OFFICE_VOICE_ENABLED;
  process.env.OFFICE_VOICE_ENABLED = "false";
  try {
    await assert.rejects(
      issueVoiceGrant("test-user", { app: "writer", document: "test", mode: "write" }),
      /disabled/,
    );
  } finally {
    if (previous === undefined) delete process.env.OFFICE_VOICE_ENABLED;
    else process.env.OFFICE_VOICE_ENABLED = previous;
  }
});
