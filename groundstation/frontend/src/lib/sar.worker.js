const SPEED_OF_LIGHT = 299792458;

function complexPowerIteration(flatRe, flatIm, rows, cols, maxIter = 100, tol = 1e-10) {
  // Find the largest singular triplet of a complex matrix stored as separate re/im arrays
  // Uses power iteration on A^H * A to find right singular vector v,
  // then u = A*v / ||A*v||

  // Random initial v (real-valued is fine for starting)
  let vRe = new Float64Array(cols);
  let vIm = new Float64Array(cols);
  for (let i = 0; i < cols; i++) vRe[i] = Math.random() - 0.5;

  let norm = Math.sqrt(vRe.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < cols; i++) vRe[i] /= norm;

  let uRe = new Float64Array(rows);
  let uIm = new Float64Array(rows);
  let sigma = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // u = A * v  (complex matrix-vector multiply)
    for (let i = 0; i < rows; i++) {
      let sRe = 0, sIm = 0;
      for (let j = 0; j < cols; j++) {
        const ar = flatRe[i * cols + j], ai = flatIm[i * cols + j];
        sRe += ar * vRe[j] - ai * vIm[j];
        sIm += ai * vRe[j] + ar * vIm[j];
      }
      uRe[i] = sRe;
      uIm[i] = sIm;
    }

    // sigma = ||u||
    sigma = Math.sqrt(uRe.reduce((s, x, i) => s + x * x + uIm[i] * uIm[i], 0));
    if (sigma < tol) return { uRe, uIm, sigma: 0, vRe, vIm };

    for (let i = 0; i < rows; i++) { uRe[i] /= sigma; uIm[i] /= sigma; }

    // v_new = A^H * u  (conjugate transpose times u)
    let vNewRe = new Float64Array(cols);
    let vNewIm = new Float64Array(cols);
    for (let j = 0; j < cols; j++) {
      let sRe = 0, sIm = 0;
      for (let i = 0; i < rows; i++) {
        // A^H[j,i] = conj(A[i,j]) = (flatRe[i*cols+j], -flatIm[i*cols+j])
        const ar = flatRe[i * cols + j], ai = -flatIm[i * cols + j];
        sRe += ar * uRe[i] - ai * uIm[i];
        sIm += ai * uRe[i] + ar * uIm[i];
      }
      vNewRe[j] = sRe;
      vNewIm[j] = sIm;
    }

    let newNorm = Math.sqrt(vNewRe.reduce((s, x, i) => s + x * x + vNewIm[i] * vNewIm[i], 0));
    if (newNorm < tol) return { uRe, uIm, sigma, vRe, vIm };

    for (let j = 0; j < cols; j++) { vNewRe[j] /= newNorm; vNewIm[j] /= newNorm; }

    let diff = 0;
    for (let j = 0; j < cols; j++) diff += (vNewRe[j] - vRe[j]) ** 2 + (vNewIm[j] - vIm[j]) ** 2;

    vRe = vNewRe;
    vIm = vNewIm;
    if (diff < tol) break;
  }

  return { uRe, uIm, sigma, vRe, vIm };
}

function applySvd(hReal, hImag, numPositions, numFreqs, k) {
  // Flatten into contiguous arrays
  const flatRe = new Float64Array(numPositions * numFreqs);
  const flatIm = new Float64Array(numPositions * numFreqs);
  for (let p = 0; p < numPositions; p++) {
    for (let f = 0; f < numFreqs; f++) {
      flatRe[p * numFreqs + f] = hReal[p][f];
      flatIm[p * numFreqs + f] = hImag[p][f];
    }
  }

  // Deflation: remove k dominant singular components
  for (let i = 0; i < k; i++) {
    const { uRe, uIm, sigma, vRe, vIm } = complexPowerIteration(flatRe, flatIm, numPositions, numFreqs);
    if (sigma < 1e-10) break;

    // Subtract sigma * u * v^H
    for (let p = 0; p < numPositions; p++) {
      for (let f = 0; f < numFreqs; f++) {
        // (u[p]) * conj(v[f]) * sigma
        // u[p] = uRe[p] + j*uIm[p], conj(v[f]) = vRe[f] - j*vIm[f]
        const outerRe = (uRe[p] * vRe[f] + uIm[p] * vIm[f]) * sigma;
        const outerIm = (uIm[p] * vRe[f] - uRe[p] * vIm[f]) * sigma;
        flatRe[p * numFreqs + f] -= outerRe;
        flatIm[p * numFreqs + f] -= outerIm;
      }
    }
  }

  // Copy back
  for (let p = 0; p < numPositions; p++) {
    for (let f = 0; f < numFreqs; f++) {
      hReal[p][f] = flatRe[p * numFreqs + f];
      hImag[p][f] = flatIm[p * numFreqs + f];
    }
  }
}

function buildWindow(numFreqs, type) {
  const win = new Float64Array(numFreqs);
  if (type === 'blackman-harris') {
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    for (let i = 0; i < numFreqs; i++) {
      const x = (2 * Math.PI * i) / (numFreqs - 1);
      win[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
    }
  } else {
    // Hanning
    for (let i = 0; i < numFreqs; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (numFreqs - 1)));
    }
  }
  return win;
}

function computeOpticalPath(lateral, depth, antennaX, wallEnabled, wallStandoffM, wallThicknessM, sqrtEr) {
  const dx = lateral - antennaX;
  if (!wallEnabled) {
    return 2 * Math.sqrt(dx * dx + depth * depth);
  }

  const wallFront = wallStandoffM;
  const wallBack = wallStandoffM + wallThicknessM;
  const er = sqrtEr * sqrtEr;

  if (depth <= wallFront) {
    return 2 * Math.sqrt(dx * dx + depth * depth);
  }

  const absDx = Math.abs(dx);

  if (absDx < 1e-9) {
    if (depth <= wallBack) {
      return 2 * (wallFront + (depth - wallFront) * sqrtEr);
    }
    return 2 * (wallFront + wallThicknessM * sqrtEr + (depth - wallBack));
  }

  // Snell's law ray tracing: find refraction point at wall surface
  // For target inside wall (depth <= wallBack):
  //   Minimize optical path: air segment + wall segment
  //   f(x) = sqrt(x^2 + wallFront^2) + sqrtEr * sqrt((absDx-x)^2 + (depth-wallFront)^2)
  //   f'(x) = x/r_air - sqrtEr*(absDx-x)/r_wall = 0  (Snell's law)
  // For target behind wall:
  //   Three segments: air → wall → air behind wall
  //   Two refraction points (entry & exit). Use iterative solver.

  if (depth <= wallBack) {
    const dWall = depth - wallFront;
    // Newton's method to find entry point x on wall front surface
    let x = absDx * wallFront / depth; // initial guess (straight-line)
    for (let iter = 0; iter < 8; iter++) {
      const rAir = Math.sqrt(x * x + wallFront * wallFront);
      const rem = absDx - x;
      const rWall = Math.sqrt(rem * rem + dWall * dWall);
      const f = x / rAir - sqrtEr * rem / rWall;
      const df = (wallFront * wallFront) / (rAir * rAir * rAir) + sqrtEr * (dWall * dWall) / (rWall * rWall * rWall);
      x -= f / df;
      if (x < 0) x = 0;
      if (x > absDx) x = absDx;
    }
    const rAir = Math.sqrt(x * x + wallFront * wallFront);
    const rWall = Math.sqrt((absDx - x) * (absDx - x) + dWall * dWall);
    return 2 * (rAir + sqrtEr * rWall);
  }

  // Target behind wall: two refraction points
  const dWall = wallThicknessM;
  const dBehind = depth - wallBack;

  // Solve for entry point x1 and exit point x2
  // Total lateral: x1 (in air front) + x2 (in wall) + x3 (in air behind) = absDx
  // Snell at entry: sin(theta_air)/1 = sin(theta_wall)/sqrtEr... actually n*sin = const
  // n_air * sin(theta1) = n_wall * sin(theta2) = n_air * sin(theta3)
  // So theta1 = theta3 (same medium), and sin(theta2) = sin(theta1)/sqrtEr
  // Single unknown: theta1. Lateral constraint: wallFront*tan(t1) + dWall*tan(t2) + dBehind*tan(t1) = absDx
  // where sin(t2) = sin(t1)/sqrtEr

  // Newton on theta1
  let sinT1 = absDx / Math.sqrt(absDx * absDx + depth * depth); // initial guess
  if (sinT1 > 0.999) sinT1 = 0.999;

  for (let iter = 0; iter < 12; iter++) {
    const cosT1 = Math.sqrt(1 - sinT1 * sinT1);
    const tanT1 = sinT1 / cosT1;
    const sinT2 = sinT1 / sqrtEr;
    if (sinT2 >= 1) { sinT1 *= 0.9; continue; } // total internal reflection guard
    const cosT2 = Math.sqrt(1 - sinT2 * sinT2);
    const tanT2 = sinT2 / cosT2;

    const lateralUsed = (wallFront + dBehind) * tanT1 + dWall * tanT2;
    const residual = lateralUsed - absDx;

    // Derivative of lateralUsed w.r.t. sinT1
    const dTanT1_dSin = 1 / (cosT1 * cosT1 * cosT1);
    const dSinT2_dSin = 1 / sqrtEr;
    const dTanT2_dSin = dSinT2_dSin / (cosT2 * cosT2 * cosT2);
    const dLateral = (wallFront + dBehind) * dTanT1_dSin + dWall * dTanT2_dSin;

    sinT1 -= residual / dLateral;
    if (sinT1 < 0) sinT1 = 0;
    if (sinT1 > 0.999) sinT1 = 0.999;
  }

  const cosT1 = Math.sqrt(1 - sinT1 * sinT1);
  const sinT2 = sinT1 / sqrtEr;
  const cosT2 = Math.sqrt(1 - sinT2 * sinT2);

  const airPath = (wallFront + dBehind) / cosT1;
  const wallPath = dWall / cosT2;
  return 2 * (airPath + sqrtEr * wallPath);
}

self.onmessage = function (e) {
  const { bscanData, bscanParams, sarParams } = e.data;
  const t0 = performance.now();

  const { stepSize } = bscanParams;
  const {
    pixelsX, pixelsZ, depthMin, depthMax, lateralMin, lateralMax,
    meanSubtract, svdEnabled, svdK, window: windowType,
    wallEnabled, wallStandoff, wallThickness, wallPermittivity,
  } = sarParams;

  const numPositions = bscanData.length;
  if (numPositions < 2) {
    self.postMessage({ type: 'result', result: null });
    return;
  }

  const hasComplex = bscanData[0].h_cal_real && bscanData[0].h_cal_imag && bscanData[0].freqs;

  const antennaX = [];
  for (let p = 0; p < numPositions; p++) {
    antennaX.push(p * stepSize / 100);
  }
  const apertureLength = (numPositions - 1) * stepSize / 100;

  const latMin = lateralMin !== undefined && lateralMin !== null ? lateralMin : 0;
  const latMax = lateralMax !== undefined && lateralMax !== null ? lateralMax : apertureLength;

  const wallStandoffM = (wallStandoff || 5) / 100;
  const wallThicknessM = (wallThickness || 15) / 100;
  const sqrtEr = Math.sqrt(wallPermittivity || 4.5);

  const image = new Float64Array(pixelsX * pixelsZ);

  if (hasComplex) {
    const numFreqs = bscanData[0].freqs.length;
    const freqs = bscanData[0].freqs;

    let hReal = [];
    let hImag = [];
    for (let p = 0; p < numPositions; p++) {
      hReal.push([...bscanData[p].h_cal_real]);
      hImag.push([...bscanData[p].h_cal_imag]);
    }

    // SVD clutter removal (proper complex SVD)
    if (svdEnabled && svdK > 0) {
      applySvd(hReal, hImag, numPositions, numFreqs, svdK);
    }

    // Mean subtraction (rank-1 removal — redundant if SVD k>=1, but cheap)
    if (meanSubtract && !(svdEnabled && svdK > 0)) {
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

    // Frequency-domain window (suppresses range sidelobes)
    const win = buildWindow(numFreqs, windowType || 'hanning');
    for (let p = 0; p < numPositions; p++) {
      for (let f = 0; f < numFreqs; f++) {
        hReal[p][f] *= win[f];
        hImag[p][f] *= win[f];
      }
    }

    const k = new Float64Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) {
      k[f] = 2 * Math.PI * freqs[f] / SPEED_OF_LIGHT;
    }

    for (let zi = 0; zi < pixelsZ; zi++) {
      const depth = depthMin + (zi / (pixelsZ - 1)) * (depthMax - depthMin);

      for (let xi = 0; xi < pixelsX; xi++) {
        const lateral = latMin + (xi / (pixelsX - 1)) * (latMax - latMin);

        let sumRe = 0;
        let sumIm = 0;

        for (let p = 0; p < numPositions; p++) {
          const roundTrip = computeOpticalPath(lateral, depth, antennaX[p], wallEnabled, wallStandoffM, wallThicknessM, sqrtEr);

          for (let f = 0; f < numFreqs; f++) {
            const phase = k[f] * roundTrip;
            const cosP = Math.cos(phase);
            const sinP = Math.sin(phase);

            const re = hReal[p][f];
            const im = hImag[p][f];
            sumRe += re * cosP - im * sinP;
            sumIm += re * sinP + im * cosP;
          }
        }

        const mag = Math.sqrt(sumRe * sumRe + sumIm * sumIm);
        image[zi * pixelsX + xi] = 20 * Math.log10(mag / (numPositions * numFreqs) + 1e-12);
      }

      if (zi % 5 === 0 || zi === pixelsZ - 1) {
        self.postMessage({ type: 'progress', progress: (zi + 1) / pixelsZ });
      }
    }
  } else {
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
          const roundTrip = computeOpticalPath(lateral, depth, antennaX[p], wallEnabled, wallStandoffM, wallThicknessM, sqrtEr) / 2;

          const binFloat = (roundTrip - distStart) / distStep;
          const binIdx = Math.floor(binFloat);
          if (binIdx < 0 || binIdx >= numBins - 1) continue;

          const frac = binFloat - binIdx;
          const mag = magMatrix[p][binIdx] * (1 - frac) + magMatrix[p][binIdx + 1] * frac;
          sum += Math.pow(10, mag / 20);
        }

        image[zi * pixelsX + xi] = 20 * Math.log10(sum / numPositions + 1e-12);
      }

      if (zi % 5 === 0 || zi === pixelsZ - 1) {
        self.postMessage({ type: 'progress', progress: (zi + 1) / pixelsZ });
      }
    }
  }

  const computeTimeMs = Math.round(performance.now() - t0);

  self.postMessage({
    type: 'result',
    result: {
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
    },
  });
};
