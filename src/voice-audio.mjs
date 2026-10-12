/** Mono PCM helpers shared by the Windows microphone recorder and its tests. */
export function concatAudioChunks(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function analyseRecording(samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid microphone sample rate.')
  let power = 0
  for (const sample of samples) power += Number.isFinite(sample) ? sample * sample : 0
  const duration = samples.length / sampleRate
  const rms = samples.length ? Math.sqrt(power / samples.length) : 0
  return { duration, rms, hasSpeech: duration >= 0.4 && rms >= 0.003 }
}

/** Average source intervals when downsampling; interpolate when upsampling. */
export function resampleMono(samples, sourceRate, targetRate = 16000) {
  if (![sourceRate, targetRate].every(rate => Number.isFinite(rate) && rate > 0)) throw new Error('Invalid audio sample rate.')
  if (!samples.length) return new Float32Array(0)
  const ratio = sourceRate / targetRate
  const length = Math.floor(samples.length / ratio)
  const result = new Float32Array(length)
  const valueAt = index => Number.isFinite(samples[index]) ? samples[index] : 0
  if (ratio === 1) {
    for (let i = 0; i < length; i++) result[i] = valueAt(i)
  } else if (ratio < 1) {
    for (let i = 0; i < length; i++) {
      const position = i * ratio
      const left = Math.floor(position)
      const right = Math.min(left + 1, samples.length - 1)
      const weight = position - left
      result[i] = valueAt(left) * (1 - weight) + valueAt(right) * weight
    }
  } else {
    for (let i = 0; i < length; i++) {
      const start = i * ratio
      const end = Math.min((i + 1) * ratio, samples.length)
      let sum = 0
      for (let index = Math.floor(start); index < end; index++) {
        const weight = Math.min(index + 1, end) - Math.max(index, start)
        sum += valueAt(index) * weight
      }
      result[i] = sum / (end - start)
    }
  }
  return result
}

export function encodeMonoWav(samples, sampleRate = 16000) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('Invalid WAV sample rate.')
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return buffer
}
