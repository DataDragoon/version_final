const SPEED_OF_LIGHT = 299792458;

export function runBackprojection(bscanData, bscanParams, sarParams) {
  const t0 = performance.now();

  const { stepSize } = bscanParams;
  const { pixelsX, pixelsZ, depthMin, depthMax, lateralMin, lateralMax, meanSubtract } = sarParams;

  const numPositions = bscanData.length;
  if (numPositions < 2) return null;

  const hasComplex = bscanData[0].h_cal_real && bscanData[0].h_cal_imag && bscanData[0].freqs;

  // Antenna positions (meters)
  const antennaX = [];
  for (let p = 0; p < numPositions; p++) {
    antennaX.push(p * stepSize / 100);
  }
  const apertureLength = (numPositions - 1) * stepSize / 100;

  const latMin = lateralMin !== undefined && lateralMin !== null ? lateralMin : 0;
  const latMax = lateralMax !== undefined && lateralMax !== null ? lateralMax : apertureLength;

  const image = new Float64Array(pixelsX * pixelsZ);

  if (hasComplex) {
    // Coherent backprojection using complex frequency-domain data
    const numFreqs = bscanData[0].freqs.length;
    const freqs = bscanData[0].freqs;

    // Build complex H(f) matrix: [position][freq] as {re, im}
    let hReal = [];
    let hImag = [];
    for (let p = 0; p < numPositions; p++) {
      hReal.push([...bscanData[p].h_cal_real]);
      hImag.push([...bscanData[p].h_cal_imag]);
    }

    // Mean subtraction in frequency domain (removes static coupling)
    if (meanSubtract) {
      const meanRe = new Array(numFreqs).fill(0);
      const meanIm = new Array(numFreqs).fill(0);
      for (let f = 0; f < numFreqs; f++) {
        for (let p = 0; p < numPositions; p++) {
          meanRe[f] += hReal[p][f];
          meanIm[f] += hImag[p][f];
        }
        meanRe[f] /= numPositions;
        meanIm[f] /= numPositions;
      }
      for (let p = 0; p < numPositions; p++) {
        for (let f = 0; f < numFreqs; f++) {
          hReal[p][f] -= meanRe[f];
          hImag[p][f] -= meanIm[f];
        }
      }
    }

    // Precompute 2*pi*f/c for phase calculation
    const k = new Float64Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) {
      k[f] = 2 * Math.PI * freqs[f] / SPEED_OF_LIGHT;
    }

    // Coherent backprojection: for each pixel, phase-shift and sum across
    // all frequencies and all antenna positions
    for (let zi = 0; zi < pixelsZ; zi++) {
      const depth = depthMin + (zi / (pixelsZ - 1)) * (depthMax - depthMin);

      for (let xi = 0; xi < pixelsX; xi++) {
        const lateral = latMin + (xi / (pixelsX - 1)) * (latMax - latMin);

        let sumRe = 0;
        let sumIm = 0;

        for (let p = 0; p < numPositions; p++) {
          const dx = lateral - antennaX[p];
          const roundTrip = 2 * Math.sqrt(dx * dx + depth * depth);

          for (let f = 0; f < numFreqs; f++) {
            // Phase correction: exp(+j*k*roundTrip) to focus at this distance
            const phase = k[f] * roundTrip;
            const cosP = Math.cos(phase);
            const sinP = Math.sin(phase);

            // Multiply H(f) by conjugate phase shift
            const re = hReal[p][f];
            const im = hImag[p][f];
            sumRe += re * cosP + im * sinP;
            sumIm += -re * sinP + im * cosP;
          }
        }

        const mag = Math.sqrt(sumRe * sumRe + sumIm * sumIm);
        image[zi * pixelsX + xi] = 20 * Math.log10(mag / (numPositions * numFreqs) + 1e-12);
      }
    }
  } else {
    // Fallback: magnitude-only incoherent backprojection
    const distances = bscanData[0].distances;
    const numBins = distances.length;

    let magMatrix = [];
    for (let p = 0; p < numPositions; p++) {
      magMatrix.push([...bscanData[p].magnitudes]);
    }

    if (meanSubtract) {
      const mean = new Array(numBins).fill(0);
      for (let b = 0; b < numBins; b++) {
        for (let p = 0; p < numPositions; p++) {
          mean[b] += magMatrix[p][b];
        }
        mean[b] /= numPositions;
      }
      for (let p = 0; p < numPositions; p++) {
        for (let b = 0; b < numBins; b++) {
          magMatrix[p][b] -= mean[b];
        }
      }
    }

    const distStart = distances[0];
    const distEnd = distances[numBins - 1];
    const distStep = (distEnd - distStart) / (numBins - 1);

    for (let zi = 0; zi < pixelsZ; zi++) {
      const depth = depthMin + (zi / (pixelsZ - 1)) * (depthMax - depthMin);

      for (let xi = 0; xi < pixelsX; xi++) {
        const lateral = latMin + (xi / (pixelsX - 1)) * (latMax - latMin);

        let sum = 0;
        for (let p = 0; p < numPositions; p++) {
          const dx = lateral - antennaX[p];
          const roundTrip = Math.sqrt(dx * dx + depth * depth);

          const binFloat = (roundTrip - distStart) / distStep;
          const binIdx = Math.floor(binFloat);
          if (binIdx < 0 || binIdx >= numBins - 1) continue;

          const frac = binFloat - binIdx;
          const mag = magMatrix[p][binIdx] * (1 - frac) + magMatrix[p][binIdx + 1] * frac;
          sum += Math.pow(10, mag / 20);
        }

        image[zi * pixelsX + xi] = 20 * Math.log10(sum / numPositions + 1e-12);
      }
    }
  }

  const computeTimeMs = Math.round(performance.now() - t0);

  return {
    image: Array.from(image),
    pixelsX,
    pixelsZ,
    depthMin,
    depthMax,
    lateralMin: latMin,
    lateralMax: latMax,
    numPositions,
    computeTimeMs,
    coherent: hasComplex,
  };
}
