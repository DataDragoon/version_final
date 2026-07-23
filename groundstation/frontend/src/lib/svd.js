/**
 * SVD clutter removal for B-scan data.
 *
 * The B-scan matrix (positions × range bins) is decomposed via SVD.
 * The first k singular values represent stationary clutter (coupling,
 * walls) since they're consistent across all positions. Removing them
 * leaves only the changing/target components.
 *
 * Uses power iteration with deflation — efficient for small k.
 */

function powerIteration(matrix, rows, cols, maxIter = 100, tol = 1e-10) {
  // Find the largest singular triplet (u, sigma, v) of matrix
  let v = new Float64Array(cols);
  for (let i = 0; i < cols; i++) v[i] = Math.random() - 0.5;

  // Normalize v
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < cols; i++) v[i] /= norm;

  let u = new Float64Array(rows);
  let sigma = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // u = A * v
    for (let i = 0; i < rows; i++) {
      let sum = 0;
      for (let j = 0; j < cols; j++) {
        sum += matrix[i * cols + j] * v[j];
      }
      u[i] = sum;
    }

    // sigma = ||u||
    sigma = Math.sqrt(u.reduce((s, x) => s + x * x, 0));
    if (sigma < tol) return { u, sigma: 0, v };

    // Normalize u
    for (let i = 0; i < rows; i++) u[i] /= sigma;

    // v_new = A^T * u
    let vNew = new Float64Array(cols);
    for (let j = 0; j < cols; j++) {
      let sum = 0;
      for (let i = 0; i < rows; i++) {
        sum += matrix[i * cols + j] * u[i];
      }
      vNew[j] = sum;
    }

    // Check convergence
    let newNorm = Math.sqrt(vNew.reduce((s, x) => s + x * x, 0));
    if (newNorm < tol) return { u, sigma, v };

    for (let j = 0; j < cols; j++) vNew[j] /= newNorm;

    let diff = 0;
    for (let j = 0; j < cols; j++) diff += (vNew[j] - v[j]) ** 2;

    v = vNew;
    if (diff < tol) break;
  }

  return { u, sigma, v };
}

export function svdFilter(bscanData, k) {
  if (!bscanData || bscanData.length < 2 || k < 1) return bscanData;

  const numPositions = bscanData.length;
  const numBins = bscanData[0].magnitudes.length;

  // Build matrix (positions × bins) from magnitudes in dB
  const flat = new Float64Array(numPositions * numBins);
  for (let p = 0; p < numPositions; p++) {
    for (let b = 0; b < numBins; b++) {
      flat[p * numBins + b] = bscanData[p].magnitudes[b];
    }
  }

  // Remove first k singular components via deflation
  for (let i = 0; i < k; i++) {
    const { u, sigma, v } = powerIteration(flat, numPositions, numBins);
    if (sigma < 1e-10) break;

    // Deflate: A = A - sigma * u * v^T
    for (let p = 0; p < numPositions; p++) {
      for (let b = 0; b < numBins; b++) {
        flat[p * numBins + b] -= sigma * u[p] * v[b];
      }
    }
  }

  // Rebuild bscanData with filtered magnitudes
  const filtered = bscanData.map((pos, p) => {
    const newMags = new Array(numBins);
    for (let b = 0; b < numBins; b++) {
      newMags[b] = flat[p * numBins + b];
    }
    return { ...pos, magnitudes: newMags };
  });

  return filtered;
}

export function svdFilterComplex(bscanData, k) {
  if (!bscanData || bscanData.length < 2 || k < 1) return bscanData;
  if (!bscanData[0].h_cal_real || !bscanData[0].h_cal_imag) return bscanData;

  const numPositions = bscanData.length;
  const numFreqs = bscanData[0].h_cal_real.length;

  // Build real and imag matrices separately
  const flatRe = new Float64Array(numPositions * numFreqs);
  const flatIm = new Float64Array(numPositions * numFreqs);
  for (let p = 0; p < numPositions; p++) {
    for (let f = 0; f < numFreqs; f++) {
      flatRe[p * numFreqs + f] = bscanData[p].h_cal_real[f];
      flatIm[p * numFreqs + f] = bscanData[p].h_cal_imag[f];
    }
  }

  // SVD on the combined magnitude for component identification
  // Build magnitude matrix to find dominant directions
  const flatMag = new Float64Array(numPositions * numFreqs);
  for (let i = 0; i < flatMag.length; i++) {
    flatMag[i] = Math.sqrt(flatRe[i] * flatRe[i] + flatIm[i] * flatIm[i]);
  }

  // Remove k components from both real and imaginary parts
  // Using SVD on real part, then applying same projection to imaginary
  for (let i = 0; i < k; i++) {
    // Find dominant singular vector of real part
    const { u: uRe, sigma: sigRe, v: vRe } = powerIteration(flatRe, numPositions, numFreqs);
    if (sigRe > 1e-10) {
      for (let p = 0; p < numPositions; p++) {
        for (let f = 0; f < numFreqs; f++) {
          flatRe[p * numFreqs + f] -= sigRe * uRe[p] * vRe[f];
        }
      }
    }

    // Find dominant singular vector of imaginary part
    const { u: uIm, sigma: sigIm, v: vIm } = powerIteration(flatIm, numPositions, numFreqs);
    if (sigIm > 1e-10) {
      for (let p = 0; p < numPositions; p++) {
        for (let f = 0; f < numFreqs; f++) {
          flatIm[p * numFreqs + f] -= sigIm * uIm[p] * vIm[f];
        }
      }
    }
  }

  // Rebuild with filtered complex data
  const filtered = bscanData.map((pos, p) => {
    const newRe = new Array(numFreqs);
    const newIm = new Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) {
      newRe[f] = flatRe[p * numFreqs + f];
      newIm[f] = flatIm[p * numFreqs + f];
    }
    return { ...pos, h_cal_real: newRe, h_cal_imag: newIm };
  });

  return filtered;
}
