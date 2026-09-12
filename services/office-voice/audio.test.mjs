import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(
  new URL("../../public/office-voice-capture.js", import.meta.url),
  "utf8",
);
for (const rate of [44100, 48000])
  test(`microphone worklet produces 16 kHz PCM frames from ${rate} Hz input`, () => {
    let Processor;
    const frames = [];
    runInNewContext(source, {
      sampleRate: rate,
      Int16Array,
      AudioWorkletProcessor: class {
        port = { postMessage: (b) => frames.push(new Int16Array(b)) };
      },
      registerProcessor: (_name, type) => {
        Processor = type;
      },
    });
    const capture = new Processor();
    const input = new Float32Array(rate * 1.6).fill(1);
    for (let i = 0; i < input.length; i += 128) capture.process([[input.subarray(i, i + 128)]]);
    assert.equal(frames.length, 20);
    assert.equal(
      frames.reduce((n, frame) => n + frame.length, 0),
      25600,
    );
    assert.ok(frames.every((frame) => frame.every((value) => value === 32767)));
  });
