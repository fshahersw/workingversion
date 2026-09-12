/* AudioWorklet: mono PCM16, 16 kHz, 80 ms frames. No microphone samples persist. */
class OfficeVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(1280);
    this.index = 0;
    this.sum = 0;
    this.weight = 0;
    this.ratio = sampleRate / 16000;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 0.000001) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 0.000001) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0;
          this.weight = 0;
          if (this.index === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(1280);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("office-voice-capture", OfficeVoiceCapture);
