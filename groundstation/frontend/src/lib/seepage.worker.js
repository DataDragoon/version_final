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
}

function fft(re, im, n) {
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
    const angle = -2 * Math.PI / len;
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
  const { wallThickness, stepSize, rangeOffset, deconvolve } = params;

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
  const offsetM = (rangeOffset || 0) / 100;
  const wallThicknessM = wallThickness / 100;
  const wallStartBin = Math.max(0, Math.floor((offsetM / maxRange) * nfft));
  const wallEndBin = Math.min(nfft / 2, Math.ceil(((offsetM + wallThicknessM) / maxRange) * nfft));

  const win = buildWindow(numFreqs, 'blackman-harris');
  const numDepthBins = wallEndBin - wallStartBin;

  // RFI spike removal: per frequency bin, find median magnitude across positions
  // and replace outliers (>3x median) with interpolated values
  const cleanData = [];
  const magMatrix = []; // [pos][freq]
  for (let p = 0; p < numPos; p++) {
    const mags = new Float64Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) {
      const re = scanData[p].h_cal_real[f];
      const im = scanData[p].h_cal_imag[f];
      mags[f] = Math.sqrt(re * re + im * im);
    }
    magMatrix.push(mags);
  }

  // Compute median magnitude per frequency bin
  const medianMag = new Float64Array(numFreqs);
  for (let f = 0; f < numFreqs; f++) {
    const vals = [];
    for (let p = 0; p < numPos; p++) vals.push(magMatrix[p][f]);
    vals.sort((a, b) => a - b);
    medianMag[f] = numPos % 2 === 0
      ? (vals[numPos / 2 - 1] + vals[numPos / 2]) / 2
      : vals[Math.floor(numPos / 2)];
  }

  // Clean each position: if magnitude > 4x median at a bin, replace with neighbor average
  for (let p = 0; p < numPos; p++) {
    const hRe = new Float64Array(scanData[p].h_cal_real);
    const hIm = new Float64Array(scanData[p].h_cal_imag);
    for (let f = 0; f < numFreqs; f++) {
      const mag = magMatrix[p][f];
      const threshold = medianMag[f] * 4;
      if (mag > threshold && medianMag[f] > 1e-12) {
        // Replace with average of neighbors
        const fPrev = f > 0 ? f - 1 : f + 1;
        const fNext = f < numFreqs - 1 ? f + 1 : f - 1;
        hRe[f] = (hRe[fPrev] + hRe[fNext]) / 2;
        hIm[f] = (hIm[fPrev] + hIm[fNext]) / 2;
      }
    }
    cleanData.push({ h_cal_real: hRe, h_cal_imag: hIm });
  }

  // Spectral equalization using cleaned data (median-based for robustness)
  const eqCurve = new Float64Array(numFreqs);
  for (let f = 0; f < numFreqs; f++) {
    eqCurve[f] = medianMag[f] || 1e-12;
  }

  const amplitudeMap = new Float64Array(numPos * numDepthBins);
  const spectralSlopeMap = new Float64Array(numPos * numDepthBins);

  // Reference-subtracted maps (only if reference provided)
  const hasRef = referenceData && referenceData.h_cal_real && referenceData.h_cal_imag;
  const subAmplitudeMap = hasRef ? new Float64Array(numPos * numDepthBins) : null;
  const subSpectralSlopeMap = hasRef ? new Float64Array(numPos * numDepthBins) : null;

  const midFreqIdx = Math.floor(numFreqs / 2);

  // Range-gate function: IFFT -> keep only wall region -> FFT back
  // This isolates wall-only signal, removing through-wall contamination
  function rangeGate(eqReIn, eqImIn) {
    const rg_re = new Float64Array(nfft);
    const rg_im = new Float64Array(nfft);
    for (let f = 0; f < numFreqs; f++) {
      rg_re[f] = eqReIn[f] * win[f];
      rg_im[f] = eqImIn[f] * win[f];
    }
    ifft(rg_re, rg_im, nfft);
    // Zero everything outside wall region
    for (let i = 0; i < nfft; i++) {
      if (i < wallStartBin || i >= wallEndBin) {
        rg_re[i] = 0;
        rg_im[i] = 0;
      }
    }
    // FFT back to frequency domain
    fft(rg_re, rg_im, nfft);
    // Extract the gated spectrum (first numFreqs bins)
    const gRe = new Float64Array(numFreqs);
    const gIm = new Float64Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) {
      gRe[f] = rg_re[f];
      gIm[f] = rg_im[f];
    }
    return { gRe, gIm };
  }

  // Surface echo deconvolution helper: extracts surface echo spectrum from a position
  // and divides the full spectrum by it to normalize coupling variations
  function deconvolveSurface(eqReIn, eqImIn) {
    // IFFT to range domain to find surface echo peak
    const dRe = new Float64Array(nfft);
    const dIm = new Float64Array(nfft);
    for (let f = 0; f < numFreqs; f++) {
      dRe[f] = eqReIn[f] * win[f];
      dIm[f] = eqImIn[f] * win[f];
    }
    ifft(dRe, dIm, nfft);

    // Find peak magnitude within surface echo region (wallStartBin ± 3 bins)
    const searchStart = Math.max(0, wallStartBin - 3);
    const searchEnd = Math.min(nfft / 2, wallStartBin + 6);
    let peakMag = 0, peakIdx = wallStartBin;
    for (let i = searchStart; i < searchEnd; i++) {
      const mag = dRe[i] * dRe[i] + dIm[i] * dIm[i];
      if (mag > peakMag) { peakMag = mag; peakIdx = i; }
    }

    // Extract window around surface peak (±2 bins)
    const halfWin = 2;
    const surfRe = new Float64Array(nfft);
    const surfIm = new Float64Array(nfft);
    for (let i = peakIdx - halfWin; i <= peakIdx + halfWin; i++) {
      if (i >= 0 && i < nfft) {
        surfRe[i] = dRe[i];
        surfIm[i] = dIm[i];
      }
    }

    // FFT back to get the surface echo's spectrum
    fft(surfRe, surfIm, nfft);

    // Divide input spectrum by surface spectrum (with regularization)
    const outRe = new Float64Array(numFreqs);
    const outIm = new Float64Array(numFreqs);
    const regFactor = peakMag * 0.01; // Wiener-style regularization
    for (let f = 0; f < numFreqs; f++) {
      const sRe = surfRe[f];
      const sIm = surfIm[f];
      const sMag2 = sRe * sRe + sIm * sIm;
      // Wiener deconvolution: H/S = H * conj(S) / (|S|^2 + reg)
      const denom = sMag2 + regFactor;
      outRe[f] = (eqReIn[f] * sRe + eqImIn[f] * sIm) / denom;
      outIm[f] = (eqImIn[f] * sRe - eqReIn[f] * sIm) / denom;
    }
    return { outRe, outIm };
  }

  for (let p = 0; p < numPos; p++) {
    const hRe = cleanData[p].h_cal_real;
    const hIm = cleanData[p].h_cal_imag;

    // Equalized spectrum: divide by median envelope to flatten system response
    const eqRe = new Float64Array(numFreqs);
    const eqIm = new Float64Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) {
      eqRe[f] = hRe[f] / eqCurve[f];
      eqIm[f] = hIm[f] / eqCurve[f];
    }

    // Surface echo deconvolution (when enabled)
    let procRe = eqRe, procIm = eqIm;
    if (deconvolve) {
      const dec = deconvolveSurface(eqRe, eqIm);
      procRe = dec.outRe;
      procIm = dec.outIm;
    }

    // --- RAW processing (equalized, optionally deconvolved) ---
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let f = 0; f < numFreqs; f++) {
      re[f] = procRe[f] * win[f];
      im[f] = procIm[f] * win[f];
    }
    ifft(re, im, nfft);

    for (let b = 0; b < numDepthBins; b++) {
      const bin = b + wallStartBin;
      const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
      amplitudeMap[p * numDepthBins + b] = 20 * Math.log10(mag + 1e-12);
    }

    // Range-gate then compute spectral slope (only wall energy contributes)
    const { gRe, gIm } = rangeGate(procRe, procIm);
    computeSpectralSlope(gRe, gIm, numFreqs, midFreqIdx, win, nfft, maxRange, wallStartBin, numDepthBins, spectralSlopeMap, p);

    // --- Reference-subtracted processing ---
    if (hasRef) {
      // Clean and equalize reference
      const refEqRe = new Float64Array(numFreqs);
      const refEqIm = new Float64Array(numFreqs);
      for (let f = 0; f < numFreqs; f++) {
        let rRe = referenceData.h_cal_real[f];
        let rIm = referenceData.h_cal_imag[f];
        const refMag = Math.sqrt(rRe * rRe + rIm * rIm);
        if (refMag > medianMag[f] * 4 && medianMag[f] > 1e-12) {
          const fP = f > 0 ? f - 1 : f + 1;
          const fN = f < numFreqs - 1 ? f + 1 : f - 1;
          rRe = (referenceData.h_cal_real[fP] + referenceData.h_cal_real[fN]) / 2;
          rIm = (referenceData.h_cal_imag[fP] + referenceData.h_cal_imag[fN]) / 2;
        }
        refEqRe[f] = rRe / eqCurve[f];
        refEqIm[f] = rIm / eqCurve[f];
      }

      // Deconvolve reference too if enabled
      let refProcRe = refEqRe, refProcIm = refEqIm;
      if (deconvolve) {
        const refDec = deconvolveSurface(refEqRe, refEqIm);
        refProcRe = refDec.outRe;
        refProcIm = refDec.outIm;
      }

      // Range-gate both current and reference before subtraction
      const { gRe: curGRe, gIm: curGIm } = rangeGate(procRe, procIm);
      const { gRe: refGRe, gIm: refGIm } = rangeGate(refProcRe, refProcIm);

      const { outRe, outIm } = alignAndSubtract(curGRe, curGIm, refGRe, refGIm, freqs, numFreqs, win);

      const subRe = new Float64Array(nfft);
      const subIm = new Float64Array(nfft);
      for (let f = 0; f < numFreqs; f++) {
        subRe[f] = outRe[f] * win[f];
        subIm[f] = outIm[f] * win[f];
      }
      ifft(subRe, subIm, nfft);

      for (let b = 0; b < numDepthBins; b++) {
        const bin = b + wallStartBin;
        const mag = Math.sqrt(subRe[bin] * subRe[bin] + subIm[bin] * subIm[bin]);
        subAmplitudeMap[p * numDepthBins + b] = 20 * Math.log10(mag + 1e-12);
      }

      computeSpectralSlope(outRe, outIm, numFreqs, midFreqIdx, win, nfft, maxRange, wallStartBin, numDepthBins, subSpectralSlopeMap, p);
    }

    self.postMessage({ type: 'progress', progress: (p + 1) / numPos });
  }

  const depthAxis = new Float64Array(numDepthBins);
  for (let b = 0; b < numDepthBins; b++) {
    depthAxis[b] = (((b + wallStartBin) / nfft) * maxRange - offsetM) * 100;
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

function computeSpectralSlope(hRe, hIm, numFreqs, midFreqIdx, win, nfft, maxRange, wallStartBin, numDepthBins, outMap, posIdx) {
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
    const bin = b + wallStartBin;
    const rangeM = (bin / nfft) * maxRange;
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
