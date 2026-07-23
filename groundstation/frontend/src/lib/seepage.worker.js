const SPEED_OF_LIGHT = 299792458;

function buildWindow(n, type) {
  const win = new Float64Array(n);
  if (type === 'blackman-harris') {
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    for (let i = 0; i < n; i++) {
      const x = (2 * Math.PI * i) / (n - 1);
      win[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
    }
  } else {
    for (let i = 0; i < n; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
  }
  return win;
}

function ifft(re, im, n) {
  const N = n;
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const angle = 2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const evenIdx = i + k, oddIdx = i + k + halfLen;
        const tRe = curRe * re[oddIdx] - curIm * im[oddIdx];
        const tIm = curRe * im[oddIdx] + curIm * re[oddIdx];
        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function alignAndSubtract(hRe, hIm, refRe, refIm, freqs, numFreqs, win) {
  // Cross-correlate in range domain to find delay offset
  const nfft = nextPow2(numFreqs * 4);

  // Windowed current
  const curRe = new Float64Array(nfft);
  const curIm = new Float64Array(nfft);
  for (let f = 0; f < numFreqs; f++) {
    curRe[f] = hRe[f] * win[f];
    curIm[f] = hIm[f] * win[f];
  }

  // Windowed reference
  const rRe = new Float64Array(nfft);
  const rIm = new Float64Array(nfft);
  for (let f = 0; f < numFreqs; f++) {
    rRe[f] = refRe[f] * win[f];
    rIm[f] = refIm[f] * win[f];
  }

  // Cross-correlation in frequency domain: conj(ref) * current
  // Then IFFT to get correlation in range domain
  const xcRe = new Float64Array(nfft);
  const xcIm = new Float64Array(nfft);
  for (let f = 0; f < nfft; f++) {
    // conj(ref) * cur = (rRe - j*rIm) * (curRe + j*curIm)
    xcRe[f] = rRe[f] * curRe[f] + rIm[f] * curIm[f];
    xcIm[f] = rRe[f] * curIm[f] - rIm[f] * curRe[f];
  }
  ifft(xcRe, xcIm, nfft);

  // Find peak in first half (positive delays only)
  let maxVal = 0, maxIdx = 0;
  const halfN = nfft / 2;
  for (let i = 0; i < halfN; i++) {
    const mag = xcRe[i] * xcRe[i] + xcIm[i] * xcIm[i];
    if (mag > maxVal) { maxVal = mag; maxIdx = i; }
  }

  // Parabolic interpolation for sub-sample peak
  const prev = Math.sqrt(xcRe[(maxIdx - 1 + nfft) % nfft] ** 2 + xcIm[(maxIdx - 1 + nfft) % nfft] ** 2);
  const curr = Math.sqrt(maxVal);
  const next = Math.sqrt(xcRe[(maxIdx + 1) % nfft] ** 2 + xcIm[(maxIdx + 1) % nfft] ** 2);
  let fracOffset = 0;
  const denom = 2 * (2 * curr - prev - next);
  if (Math.abs(denom) > 1e-12) {
    fracOffset = (prev - next) / denom;
  }
  const peakBin = maxIdx + fracOffset;

  // Convert bin offset to time delay
  const stepHz = (freqs[numFreqs - 1] - freqs[0]) / (numFreqs - 1);
  const maxRange = SPEED_OF_LIGHT / (2 * stepHz);
  const delaySeconds = (peakBin / nfft) * (2 * maxRange / SPEED_OF_LIGHT);

  // Amplitude scaling: match reference energy to current energy in surface echo region
  let curEnergy = 0, refEnergy = 0;
  for (let f = 0; f < numFreqs; f++) {
    curEnergy += hRe[f] * hRe[f] + hIm[f] * hIm[f];
    refEnergy += refRe[f] * refRe[f] + refIm[f] * refIm[f];
  }
  const scale = refEnergy > 1e-20 ? Math.sqrt(curEnergy / refEnergy) : 1;

  // Apply phase ramp (shift) and amplitude scale to reference, then subtract
  const outRe = new Float64Array(numFreqs);
  const outIm = new Float64Array(numFreqs);
  for (let f = 0; f < numFreqs; f++) {
    const phase = -2 * Math.PI * freqs[f] * delaySeconds;
    const cosP = Math.cos(phase);
    const sinP = Math.sin(phase);
    // Shifted & scaled reference
    const shiftedRe = scale * (refRe[f] * cosP - refIm[f] * sinP);
    const shiftedIm = scale * (refRe[f] * sinP + refIm[f] * cosP);
    // Subtract
    outRe[f] = hRe[f] - shiftedRe;
    outIm[f] = hIm[f] - shiftedIm;
  }

  return { outRe, outIm };
}

self.onmessage = function (e) {
  const { scanData, params, referenceData } = e.data;
  const { wallThickness, stepSize } = params;

  const numPos = scanData.length;
  if (numPos === 0) {
    self.postMessage({ type: 'result', result: null });
    return;
  }

  const hasComplex = scanData[0].h_cal_real && scanData[0].h_cal_imag && scanData[0].freqs;
  if (!hasComplex) {
    self.postMessage({ type: 'result', result: null });
    return;
  }

  const freqs = scanData[0].freqs;
  const numFreqs = freqs.length;
  const stepHz = (freqs[numFreqs - 1] - freqs[0]) / (numFreqs - 1);
  const maxRange = SPEED_OF_LIGHT / (2 * stepHz);

  const nfft = nextPow2(numFreqs * 4);
  const wallThicknessM = wallThickness / 100;
  const wallEndBin = Math.min(nfft / 2, Math.ceil((wallThicknessM / maxRange) * nfft));

  const win = buildWindow(numFreqs, 'blackman-harris');
  const numDepthBins = wallEndBin;

  const amplitudeMap = new Float64Array(numPos * numDepthBins);
  const spectralSlopeMap = new Float64Array(numPos * numDepthBins);

  // Reference-subtracted maps (only if reference provided)
  const hasRef = referenceData && referenceData.h_cal_real && referenceData.h_cal_imag;
  const subAmplitudeMap = hasRef ? new Float64Array(numPos * numDepthBins) : null;
  const subSpectralSlopeMap = hasRef ? new Float64Array(numPos * numDepthBins) : null;

  const midFreqIdx = Math.floor(numFreqs / 2);

  for (let p = 0; p < numPos; p++) {
    const hRe = scanData[p].h_cal_real;
    const hIm = scanData[p].h_cal_imag;

    // --- RAW processing ---
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let f = 0; f < numFreqs; f++) {
      re[f] = hRe[f] * win[f];
      im[f] = hIm[f] * win[f];
    }
    ifft(re, im, nfft);

    for (let b = 0; b < numDepthBins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      amplitudeMap[p * numDepthBins + b] = 20 * Math.log10(mag + 1e-12);
    }

    // Spectral slope (raw)
    computeSpectralSlope(hRe, hIm, numFreqs, midFreqIdx, win, nfft, maxRange, numDepthBins, spectralSlopeMap, p);

    // --- Reference-subtracted processing ---
    if (hasRef) {
      const { outRe, outIm } = alignAndSubtract(hRe, hIm, referenceData.h_cal_real, referenceData.h_cal_imag, freqs, numFreqs, win);

      const subRe = new Float64Array(nfft);
      const subIm = new Float64Array(nfft);
      for (let f = 0; f < numFreqs; f++) {
        subRe[f] = outRe[f] * win[f];
        subIm[f] = outIm[f] * win[f];
      }
      ifft(subRe, subIm, nfft);

      for (let b = 0; b < numDepthBins; b++) {
        const mag = Math.sqrt(subRe[b] * subRe[b] + subIm[b] * subIm[b]);
        subAmplitudeMap[p * numDepthBins + b] = 20 * Math.log10(mag + 1e-12);
      }

      computeSpectralSlope(outRe, outIm, numFreqs, midFreqIdx, win, nfft, maxRange, numDepthBins, subSpectralSlopeMap, p);
    }

    self.postMessage({ type: 'progress', progress: (p + 1) / numPos });
  }

  const depthAxis = new Float64Array(numDepthBins);
  for (let b = 0; b < numDepthBins; b++) {
    depthAxis[b] = ((b / nfft) * maxRange) * 100;
  }

  const result = {
    amplitudeMap: Array.from(amplitudeMap),
    spectralSlopeMap: Array.from(spectralSlopeMap),
    numPos,
    numDepthBins,
    depthAxis: Array.from(depthAxis),
    stepSize,
    wallThickness,
  };

  if (hasRef) {
    result.subAmplitudeMap = Array.from(subAmplitudeMap);
    result.subSpectralSlopeMap = Array.from(subSpectralSlopeMap);
  }

  self.postMessage({ type: 'result', result });
};

function computeSpectralSlope(hRe, hIm, numFreqs, midFreqIdx, win, nfft, maxRange, numDepthBins, outMap, posIdx) {
  const nfftHalf = nextPow2(midFreqIdx * 4);
  const reLow = new Float64Array(nfftHalf);
  const imLow = new Float64Array(nfftHalf);
  const winLow = buildWindow(midFreqIdx, 'blackman-harris');
  for (let f = 0; f < midFreqIdx; f++) {
    reLow[f] = hRe[f] * winLow[f];
    imLow[f] = hIm[f] * winLow[f];
  }
  ifft(reLow, imLow, nfftHalf);

  const highLen = numFreqs - midFreqIdx;
  const nfftHigh = nextPow2(highLen * 4);
  const reHigh = new Float64Array(nfftHigh);
  const imHigh = new Float64Array(nfftHigh);
  const winHigh = buildWindow(highLen, 'blackman-harris');
  for (let f = 0; f < highLen; f++) {
    reHigh[f] = hRe[f + midFreqIdx] * winHigh[f];
    imHigh[f] = hIm[f + midFreqIdx] * winHigh[f];
  }
  ifft(reHigh, imHigh, nfftHigh);

  for (let b = 0; b < numDepthBins; b++) {
    const rangeM = (b / nfft) * maxRange;
    const bLow = Math.floor((rangeM / maxRange) * nfftHalf);
    const bHigh = Math.floor((rangeM / maxRange) * nfftHigh);

    let magLow = 0, magHigh = 0;
    if (bLow < nfftHalf) {
      magLow = Math.sqrt(reLow[bLow] * reLow[bLow] + imLow[bLow] * imLow[bLow]);
    }
    if (bHigh < nfftHigh) {
      magHigh = Math.sqrt(reHigh[bHigh] * reHigh[bHigh] + imHigh[bHigh] * imHigh[bHigh]);
    }

    const dbLow = 20 * Math.log10(magLow + 1e-12);
    const dbHigh = 20 * Math.log10(magHigh + 1e-12);
    outMap[posIdx * numDepthBins + b] = dbLow - dbHigh;
  }
}
