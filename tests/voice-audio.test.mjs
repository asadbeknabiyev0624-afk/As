import test from 'node:test'
import assert from 'node:assert/strict'
import { analyseRecording, concatAudioChunks, encodeMonoWav, resampleMono } from '../src/voice-audio.mjs'

test('microphone WAV preserves mono PCM format, sample rate and signed audio samples', () => {
  const wav = encodeMonoWav(new Float32Array([-2, -0.5, 0, 0.5, 2, NaN]), 16000)
  const view = new DataView(wav)
  const text = (offset, length) => String.fromCharCode(...new Uint8Array(wav, offset, length))
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(text(8, 4), 'WAVE')
  assert.equal(view.getUint32(4, true), wav.byteLength - 8)
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 12)
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -16384, 0, 16384, 32767, 0])
})

test('microphone resampling preserves speech timing and pitch at 44.1 and 48 kHz', () => {
  for (const sourceRate of [44100, 48000]) {
    const source = Float32Array.from({ length: sourceRate / 10 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / sourceRate))
    const result = resampleMono(source, sourceRate)
    assert.equal(result.length, 1600)
    assert.ok(result.every(Number.isFinite))
    let cycles = 0
    for (let i = 1; i < result.length; i++) if (result[i - 1] < 0 && result[i] >= 0) cycles++
    assert.ok(cycles >= 99 && cycles <= 100, `1 kHz signal changed pitch: ${cycles} cycles`)
    assert.ok(analyseRecording(result, 16000).rms > 0.65)
  }
  const constant = resampleMono(new Float32Array(800).fill(0.25), 8000)
  assert.equal(constant.length, 1600)
  assert.ok(constant.every(sample => sample === 0.25))
})

test('empty, short and silent recordings do not qualify for Whisper transcription', () => {
  assert.equal(analyseRecording(new Float32Array(0), 16000).hasSpeech, false)
  assert.equal(analyseRecording(new Float32Array(16000), 16000).hasSpeech, false)
  assert.equal(analyseRecording(new Float32Array(3200).fill(0.1), 16000).hasSpeech, false)
  assert.equal(analyseRecording(new Float32Array(8000).fill(0.0001), 16000).hasSpeech, false)
  assert.equal(analyseRecording(new Float32Array(8000).fill(0.1), 16000).hasSpeech, true)
  const chunks = [new Float32Array([0.1, 0.2]), new Float32Array([0.3])]
  assert.deepEqual(concatAudioChunks(chunks), new Float32Array([0.1, 0.2, 0.3]))
})
