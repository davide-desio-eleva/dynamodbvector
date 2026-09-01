/**
 * AudioWorklet processor for capturing and converting audio to PCM 16-bit.
 * Runs on a separate audio thread for better performance.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const inputData = input[0];
    const pcmData = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    this.port.postMessage({ type: "audio", data: pcmData });
    return true;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
