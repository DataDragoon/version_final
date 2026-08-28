import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Viewport from './components/Viewport';
import { svdFilter } from './lib/svd';
import { useSarWorker } from './hooks/useSarWorker';
import { useBgModelWorker } from './hooks/useBgModelWorker';
import { inferBgModel } from './lib/bgModelInfer';
import { computeCaptureStats } from './lib/bgCaptureStats';
import { computeRangeProfile } from './lib/rangeProfile';
import { applyBscanBg, bgForStandoff, freqGrid } from './lib/bscanBg';
import { cellForIndex } from './lib/cscanGrid';
import { DEFAULT_PARAMS as IMAGING_DEFAULT_PARAMS } from './lib/imagingEffects';

const SPEED_OF_LIGHT = 299792458;

function runPhaseUnwindTest(samples, sfcwParams) {
  const startHz = sfcwParams.startFreq * 1e6;
  const stopHz = sfcwParams.stopFreq * 1e6;
  const numSteps = samples[0].num_steps;

  const freqs = [];
  for (let i = 0; i < numSteps; i++) {
    freqs.push(startHz + (i / (numSteps - 1)) * (stopHz - startHz));
  }

  const residuals = [];
  const reconstructionErrors = [];

  for (const sample of samples) {
    const d = sample.lidar_standoff_mm / 1000;
    const residualReal = new Array(numSteps);
    const residualImag = new Array(numSteps);
    let maxErr = 0;
    let sumErrSq = 0;

    for (let i = 0; i < numSteps; i++) {
      // Unwind: multiply by exp(+j * 4π * f * d / c)
      const phase = 4 * Math.PI * freqs[i] * d / SPEED_OF_LIGHT;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      const origR = sample.h_cal_real[i];
      const origI = sample.h_cal_imag[i];
      residualReal[i] = origR * cosP - origI * sinP;
      residualImag[i] = origR * sinP + origI * cosP;

      // Rewind: multiply by exp(-j * 4π * f * d / c)
      const reconR = residualReal[i] * cosP + residualImag[i] * sinP;
      const reconI = -residualReal[i] * sinP + residualImag[i] * cosP;

      const errR = reconR - origR;
      const errI = reconI - origI;
      const errMag = Math.sqrt(errR * errR + errI * errI);
      sumErrSq += errMag * errMag;
      if (errMag > maxErr) maxErr = errMag;
    }

    residuals.push({ real: residualReal, imag: residualImag, distance: d });
    reconstructionErrors.push({
      maxError: maxErr,
      rmsError: Math.sqrt(sumErrSq / numSteps),
    });
  }

  // Cross-sweep residual consistency: how similar are the 5 residuals to each other?
  const meanResidualReal = new Array(numSteps).fill(0);
  const meanResidualImag = new Array(numSteps).fill(0);
  for (const r of residuals) {
    for (let i = 0; i < numSteps; i++) {
      meanResidualReal[i] += r.real[i] / residuals.length;
      meanResidualImag[i] += r.imag[i] / residuals.length;
    }
  }

  let totalVariance = 0;
  let totalSignalPower = 0;
  for (const r of residuals) {
    for (let i = 0; i < numSteps; i++) {
      const diffR = r.real[i] - meanResidualReal[i];
      const diffI = r.imag[i] - meanResidualImag[i];
      totalVariance += diffR * diffR + diffI * diffI;
      totalSignalPower += meanResidualReal[i] ** 2 + meanResidualImag[i] ** 2;
    }
  }
  const snrLinear = totalSignalPower / (totalVariance || 1e-30);
  const snrDb = 10 * Math.log10(snrLinear);

  // Correlation between consecutive residuals
  let corrSum = 0;
  for (let k = 0; k < residuals.length - 1; k++) {
    let dotRe = 0, dotIm = 0, magA = 0, magB = 0;
    for (let i = 0; i < numSteps; i++) {
      const aR = residuals[k].real[i], aI = residuals[k].imag[i];
      const bR = residuals[k + 1].real[i], bI = residuals[k + 1].imag[i];
      dotRe += aR * bR + aI * bI;
      dotIm += aI * bR - aR * bI;
      magA += aR * aR + aI * aI;
      magB += bR * bR + bI * bI;
    }
    corrSum += Math.sqrt(dotRe * dotRe + dotIm * dotIm) / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-30);
  }
  const avgCorrelation = corrSum / (residuals.length - 1);

  return {
    reconstructionErrors,
    maxErrorOverall: Math.max(...reconstructionErrors.map(e => e.maxError)),
    rmsErrorOverall: Math.sqrt(reconstructionErrors.reduce((s, e) => s + e.rmsError ** 2, 0) / reconstructionErrors.length),
    residualSnrDb: snrDb,
    residualCorrelation: avgCorrelation,
    residuals,
    freqs,
    distances: samples.map(s => s.lidar_standoff_mm),
  };
}

export default function App() {
  const [activePanel, setActivePanel] = useState(null);
  const [piIp, setPiIp] = useState(() => localStorage.getItem('pi_ip') || '');

  // IMU state
  const [imuData, setImuData] = useState(null);
  const [imuRate, setImuRate] = useState(0);
  const imuCountRef = useRef(0);
  const [lidarMm, setLidarMm] = useState(null);
  // Provenance of the standoff used for the most recent sweep (Phase 0.1/0.2):
  // { lidar_standoff_mm, lidar_n, lidar_std, lidar_offset_mm, roll_deg, pitch_deg }
  const [sfcwLidarProvenance, setSfcwLidarProvenance] = useState(null);

  // SDR / RF Calib state — antenna (TX1/RX1) and reference (TX2/RX2) both stream
  // simultaneously now, so RX preview/FFT are tracked per channel.
  const [sdrStatus, setSdrStatus] = useState(null);
  const [rxSamplesAnt, setRxSamplesAnt] = useState([]);
  const [rxSamplesRef, setRxSamplesRef] = useState([]);
  const [fftDataAnt, setFftDataAnt] = useState(null);
  const [fftDataRef, setFftDataRef] = useState(null);
  const [txActive, setTxActive] = useState(false);
  const [rxActive, setRxActive] = useState(false);
  const [showFFT, setShowFFT] = useState(true);
  const [graphPaused, setGraphPaused] = useState(false);

  // SFCW state
  const [sfcwRunning, setSfcwRunning] = useState(false);
  const [sfcwStatus, setSfcwStatus] = useState(null);
  const [sfcwResult, setSfcwResult] = useState(null);
  const [sfcwProgress, setSfcwProgress] = useState(null);
  const [coherenceResult, setCoherenceResult] = useState(null);

  // SFCW range scale ({min, max} in meters)
  const [sfcwRangeScale, setSfcwRangeScale] = useState({ min: 0, max: 3 });

  // SFCW amplitude scale. Dynamic by default; manual pins the range profile's
  // Y axis and the waterfall colour range together. `isDb` records which units
  // the pinned numbers are in — the display drops back to dynamic if its
  // dB/LIN mode changes underneath them. The live dynamic limits live in a ref
  // (the display rewrites them every frame) so the panel can seed on toggle
  // without re-rendering on every sweep.
  const [sfcwScaleRange, setSfcwScaleRange] = useState({ dynamic: true, min: -60, max: 0, isDb: true });
  const sfcwDynamicScale = useRef({ min: -60, max: 0, isDb: true });
  const handleSfcwDynamicScale = useCallback((r) => { sfcwDynamicScale.current = r; }, []);
  const getSfcwDynamicScale = useCallback(() => sfcwDynamicScale.current, []);

  // SFCW panel params (lifted so they survive panel switches)
  const [sfcwParams, setSfcwParams] = useState({
    startFreq: 2000,
    stopFreq: 5000,
    stepSize: 60,
    numBuffers: 4,
    settleCount: 0,
    tx1Gain: 50,
    rx1Gain: 25,
    rangeOffset: 0.5,
  });

  const sfcwParamsRef = useRef(sfcwParams);
  sfcwParamsRef.current = sfcwParams;

  // Background Model state
  const [bgModelCaptures, setBgModelCaptures] = useState([]);
  // Positions are static, so sweeps within a capture are replicas whose only
  // job is coherent averaging. More of them buys 10*log10(N) dB of noise
  // rejection; sweeping is cheap, repositioning by hand is not.
  const [bgModelSweepsPerCapture, setBgModelSweepsPerCaptureState] = useState(
    () => Number(localStorage.getItem('bgmodel_sweeps')) || 40
  );
  const setBgModelSweepsPerCapture = useCallback((v) => {
    const n = Math.max(1, Math.min(500, Math.round(Number(v)) || 1));
    localStorage.setItem('bgmodel_sweeps', String(n));
    setBgModelSweepsPerCaptureState(n);
  }, []);
  const [bgModelCapturing, setBgModelCapturing] = useState(false);
  const [bgModelAccumCount, setBgModelAccumCount] = useState(0);
  const bgModelAccumRef = useRef(null);
  const [bgModelTesting, setBgModelTesting] = useState(false);
  const [bgModelTestCount, setBgModelTestCount] = useState(0);
  const [bgModelTestResult, setBgModelTestResult] = useState(null);
  const bgModelTestRef = useRef(null);
  const bgModelWorker = useBgModelWorker();

  // SFCW background subtraction. Two mutually exclusive sources, both applied
  // groundstation-side: a captured reference sweep, or a trained ML model.
  const [sfcwBgModel, setSfcwBgModel] = useState(null);
  const [sfcwBgRef, setSfcwBgRef] = useState(null);
  const [sfcwBgCapturing, setSfcwBgCapturing] = useState(false);
  const sfcwBgCaptureRef = useRef(false);
  const [sfcwStandoffMm, setSfcwStandoffMm] = useState(null);

  // Capturing a reference drops any loaded model, and vice versa.
  const handleSfcwCaptureBg = useCallback(() => {
    setSfcwBgModel(null);
    setSfcwBgCapturing(true);
    sfcwBgCaptureRef.current = true;
  }, []);

  const handleSfcwLoadBgModel = useCallback((model) => {
    setSfcwBgRef(null);
    sfcwBgCaptureRef.current = false;
    setSfcwBgCapturing(false);
    setSfcwBgModel(model);
  }, []);

  const handleSfcwClearBg = useCallback(() => {
    setSfcwBgModel(null);
    setSfcwBgRef(null);
    sfcwBgCaptureRef.current = false;
    setSfcwBgCapturing(false);
  }, []);

  // Imaging Bench state. Entirely offline — it reads a waterfall_snapshot
  // exported from the SFCW panel and never touches the Pi, so none of this is
  // wired to the SDR socket.
  const [imagingSnapshot, setImagingSnapshot] = useState(null);
  const [imagingSnapshotName, setImagingSnapshotName] = useState(null);
  const [imagingEffect, setImagingEffect] = useState('none');
  const [imagingParams, setImagingParams] = useState(IMAGING_DEFAULT_PARAMS);

  const handleLoadImagingSnapshot = useCallback((snap, name) => {
    setImagingSnapshot(snap);
    setImagingSnapshotName(name);
    // displayState is provenance, not processing: it seeds the "None" effect and
    // the shared range-profile knobs so the bench opens on the image the
    // operator was actually looking at, and is ignored everywhere else.
    const ds = snap.displayState || {};
    const maxRange = SPEED_OF_LIGHT / (2 * snap.common.step_size);
    setImagingParams(prev => ({
      ...prev,
      none: { ...prev.none, ...(ds.scaleMode ? { scaleMode: ds.scaleMode } : {}) },
      profile: {
        ...prev.profile,
        ...(ds.windowType ? { windowType: ds.windowType } : {}),
        ...(ds.kaiserBeta != null ? { kaiserBeta: ds.kaiserBeta } : {}),
        ...(ds.rangeComp != null ? { rangeComp: ds.rangeComp } : {}),
      },
      view: {
        ...prev.view,
        rangeMin: 0,
        rangeMax: maxRange / 2,
        sweepIndex: snap.sweeps.length - 1,
        followLatest: true,
      },
    }));
  }, []);

  const handleClearImagingSnapshot = useCallback(() => {
    setImagingSnapshot(null);
    setImagingSnapshotName(null);
  }, []);

  // B-Scan state. Background subtraction has the same two mutually exclusive
  // sources as the SFCW panel — a captured reference sweep or a trained model —
  // and both are applied groundstation-side. The Pi only ships raw h_cal.
  const [bscanData, setBscanData] = useState([]);
  const [bscanCapturing, setBscanCapturing] = useState(false);
  const [bscanBgRef, setBscanBgRef] = useState(null);
  const [bscanBgModel, setBscanBgModel] = useState(null);
  const [bscanBgCapturing, setBscanBgCapturing] = useState(false);
  const [bgApplied, setBgApplied] = useState(true);
  // The next sweep to arrive is tagged as a position / as the BG reference.
  const bscanCaptureRef = useRef(false);
  const bscanBgCaptureRef = useRef(false);

  // Distance from the lidar's reference plane to the antenna aperture, so
  // standoff = lidar_reading - offset. It is a property of the mounting and
  // changes whenever the head is re-mounted, so it is user-editable and
  // persisted rather than hardcoded.
  //
  // Measured on the bench 2026-08-28: with the aperture against the wall (true
  // zero standoff) the lidar reads 164.83 mm +/- 0.68. 160 keeps a 5 mm buffer
  // so a real zero-standoff pose reports slightly positive rather than negative.
  // Re-measure after any re-mount.
  //
  // Getting this wrong is not symmetric. A constant offset error *cancels
  // exactly* for a model trained and used under that same offset: the unwind
  // factor is common to every knot, factors through the interpolation, and is
  // undone by the rewind. What it does break is the model's span. The previous
  // hardcoded 315 mm put zero standoff 150 mm behind the actual aperture, so
  // every live query against models/4th model.json (knots 11-167 mm) landed at
  // -150..0 mm -- outside the span on every single sweep, where inferInterpModel
  // silently clamps. Measured cost of that: ~20 dB, and past ~20 mm outside the
  // subtraction adds energy instead of removing it, which manufactures targets.
  // Hence the geometry stamp on new models (handleBgModelAction 'build') and the
  // out-of-span reporting in sfcwProcessed below.
  const [lidarOffsetMm, setLidarOffsetMmState] = useState(() => {
    const v = parseFloat(localStorage.getItem('lidar_antenna_offset_mm'));
    return Number.isFinite(v) ? v : 160;
  });
  const setLidarOffsetMm = useCallback((v) => {
    localStorage.setItem('lidar_antenna_offset_mm', String(v));
    setLidarOffsetMmState(v);
  }, []);
  const lidarOffsetRef = useRef(lidarOffsetMm);
  lidarOffsetRef.current = lidarOffsetMm;

  // Distinct lidar readings seen since the last sweep. Deduped by `lidar_seq`
  // (added to the Pi packet 2026-08-28): the stream broadcasts at ~50 Hz while
  // the LiDAR is polled at 20 Hz and only updates internally at ~17 Hz, so most
  // packets repeat the previous reading. Averaging the repeats would understate
  // the spread and silently weight each reading by how long it happened to be
  // held, so `lidar_n` and `lidar_std` recorded on each sweep would be fiction.
  const lidarAccumRef = useRef([]);
  const lidarLastSeqRef = useRef(null);
  // Roll/pitch accumulated over the same window (Phase 0.2). Recorded so it is
  // possible to test later whether the background depends on pose as well as
  // standoff -- cheap to capture now, impossible to backfill.
  const poseAccumRef = useRef([]);
  // C-scan raster: a hCount x vCount grid captured along a snake path (see
  // lib/cscanGrid.js). vCount = 1 degenerates to the old single-line B-scan.
  const [bscanParams, setBscanParams] = useState({
    hCount: 20,
    hStep: 5,
    vCount: 1,
    vStep: 5,
    maxDepth: 30,
    gateStart: 2,
    gateEnd: 15,
    metric: 'peak',
  });
  // The SDR message handler is mounted once, so it reads the grid through a ref.
  const bscanParamsRef = useRef(bscanParams);
  bscanParamsRef.current = bscanParams;

  // B-scan display toggles
  const [bscanScaleMode, setBscanScaleMode] = useState('linear');
  const [bscanDisplayMode, setBscanDisplayMode] = useState('color');
  // Colour limits: dynamic follows the data, manual pins both ends live.
  const [bscanScaleRange, setBscanScaleRange] = useState({ dynamic: true, min: -90, max: -20 });

  const bscanBgSource = useMemo(
    () => ({ bgRef: bscanBgRef, bgModel: bscanBgModel }),
    [bscanBgRef, bscanBgModel],
  );

  // Capturing a reference drops any loaded model, and vice versa.
  const handleBscanCaptureBg = useCallback(() => {
    setBscanBgModel(null);
    setBscanBgCapturing(true);
    bscanBgCaptureRef.current = true;
  }, []);

  const handleBscanLoadBgModel = useCallback((model) => {
    setBscanBgRef(null);
    bscanBgCaptureRef.current = false;
    setBscanBgCapturing(false);
    setBscanBgModel(model);
  }, []);

  const handleBscanClearBg = useCallback(() => {
    setBscanBgRef(null);
    setBscanBgModel(null);
    bscanBgCaptureRef.current = false;
    setBscanBgCapturing(false);
  }, []);

  // The background as a displayable range profile (no subtraction — raw BG).
  // With a model there is no single reference sweep, so it is evaluated at the
  // first captured position's standoff to give the same visual sanity check.
  const bscanBgDisplay = useMemo(() => {
    let real = null;
    let imag = null;
    let stepSize = null;
    let rangeOffset = null;
    let standoffMm = null;

    if (bscanBgModel) {
      const pos = bscanData.find(p => p.h_cal_real && p.lidar_standoff_mm != null);
      if (!pos) return null;
      const numSteps = pos.h_cal_real.length;
      const bg = bgForStandoff(bscanBgSource, pos.lidar_standoff_mm, numSteps,
        freqGrid(sfcwParams.startFreq, sfcwParams.stopFreq, numSteps));
      if (!bg) return null;
      real = bg.bgReal;
      imag = bg.bgImag;
      stepSize = pos.step_size;
      rangeOffset = pos.range_offset;
      standoffMm = pos.lidar_standoff_mm;
    } else if (bscanBgRef && bscanBgRef.h_cal_real && bscanBgRef.h_cal_imag) {
      real = bscanBgRef.h_cal_real;
      imag = bscanBgRef.h_cal_imag;
      stepSize = bscanBgRef.step_size;
      rangeOffset = bscanBgRef.range_offset;
      standoffMm = bscanBgRef.lidar_standoff_mm;
    } else {
      return null;
    }

    const rp = computeRangeProfile(real, imag, real.length, stepSize, rangeOffset);
    return { magnitudes: rp.magnitudes, distances: rp.distances, standoffMm, isModel: !!bscanBgModel };
  }, [bscanBgRef, bscanBgModel, bscanBgSource, bscanData, sfcwParams.startFreq, sfcwParams.stopFreq]);


  // B-scan processing: complex BG subtract (model or reference) → IFFT
  const processedBscanData = useMemo(
    () => applyBscanBg(bscanData, { enabled: bgApplied, ...bscanBgSource }, sfcwParams),
    [bscanData, bscanBgSource, bgApplied, sfcwParams],
  );

  // Compute spatial alignment bin shifts using lidar standoff data
  const alignShifts = useMemo(() => {
    if (processedBscanData.length < 2) {
      return { scanShifts: processedBscanData.map(() => 0), bgShift: 0 };
    }

    const distances = processedBscanData[0].distances;
    if (!distances || distances.length < 2) {
      return { scanShifts: processedBscanData.map(() => 0), bgShift: 0 };
    }
    const binSpacingM = distances[1] - distances[0];

    const hasLidar = processedBscanData.every(pos => pos.lidar_standoff_mm != null);
    if (!hasLidar) {
      return { scanShifts: processedBscanData.map(() => 0), bgShift: 0 };
    }

    const standoffs = processedBscanData.map(pos => pos.lidar_standoff_mm / 1000);
    const maxStandoff = Math.max(...standoffs);

    const scanShifts = standoffs.map(s => (maxStandoff - s) / binSpacingM);

    // The BG row is drawn at whatever standoff it was evaluated at — the
    // reference sweep's, or the position the model was sampled at.
    let bgShift = 0;
    if (bscanBgDisplay && bscanBgDisplay.standoffMm != null) {
      bgShift = (maxStandoff - bscanBgDisplay.standoffMm / 1000) / binSpacingM;
    } else if (bscanBgDisplay && bscanBgDisplay.magnitudes) {
      let bgPeakIdx = 0, maxVal = -Infinity;
      for (let i = 0; i < bscanBgDisplay.magnitudes.length; i++) {
        if (bscanBgDisplay.magnitudes[i] > maxVal) { maxVal = bscanBgDisplay.magnitudes[i]; bgPeakIdx = i; }
      }
      const maxStandoffScanPeak = (() => {
        const idx = standoffs.indexOf(maxStandoff);
        const mags = processedBscanData[idx].magnitudes;
        let pk = 0, mv = -Infinity;
        for (let i = 0; i < mags.length; i++) { if (mags[i] > mv) { mv = mags[i]; pk = i; } }
        return pk;
      })();
      bgShift = maxStandoffScanPeak - bgPeakIdx;
      if (bgShift < 0) bgShift = 0;
    }

    return { scanShifts, bgShift };
  }, [processedBscanData, bscanBgDisplay]);
  // 2D Map state
  const [mapGateStart, setMapGateStart] = useState(2);
  const [mapGateEnd, setMapGateEnd] = useState(15);
  const [mapDynRange, setMapDynRange] = useState(30);
  const [mapMetric, setMapMetric] = useState('peak');
  const [mapFocusEnabled, setMapFocusEnabled] = useState(false);
  const [mapFocusAperture, setMapFocusAperture] = useState(7);
  const [mapSvdEnabled, setMapSvdEnabled] = useState(false);
  const [mapSvdK, setMapSvdK] = useState(1);
  const [mapSvdStrength, setMapSvdStrength] = useState(0.5);

  // SAR processing state (independent of B-scan panel)
  const [sarBgEnabled, setSarBgEnabled] = useState(true);
  const [sarSvdEnabled, setSarSvdEnabled] = useState(false);
  const [sarSvdK, setSarSvdK] = useState(1);
  const [sarSvdStrength, setSarSvdStrength] = useState(1.0);
  const [sarScaleMode, setSarScaleMode] = useState('db');
  const [sarAperture, setSarAperture] = useState(1);
  const [sarCoherent, setSarCoherent] = useState(true);
  const [sarDynRange, setSarDynRange] = useState(20);

  const sarProcessedData = useMemo(
    () => applyBscanBg(bscanData, { enabled: sarBgEnabled, ...bscanBgSource }, sfcwParams),
    [bscanData, bscanBgSource, sarBgEnabled, sfcwParams],
  );

  const sarBscanInput = useMemo(() => {
    if (!sarSvdEnabled || sarProcessedData.length < 2) return sarProcessedData;
    return svdFilter(sarProcessedData, sarSvdK, sarSvdStrength);
  }, [sarProcessedData, sarSvdEnabled, sarSvdK, sarSvdStrength]);

  // SAR and the 2D Map are one-dimensional: they read the horizontal step as the
  // aperture spacing and treat the capture sequence as a line.
  const sarParams = useMemo(() => ({ ...bscanParams, stepSize: bscanParams.hStep, aperture: sarAperture, coherent: sarCoherent, startFreq: sfcwParams.startFreq, svdEnabled: sarSvdEnabled, svdK: sarSvdK, svdStrength: sarSvdStrength }), [bscanParams, sarAperture, sarCoherent, sfcwParams.startFreq, sarSvdEnabled, sarSvdK, sarSvdStrength]);
  const { sarResult, sarProgress } = useSarWorker(sarBscanInput, sarParams);

  // 2D Map uses the same processed B-scan as the main B-scan panel, optionally with its own SVD
  const mapBscanData = useMemo(() => {
    if (!mapSvdEnabled || processedBscanData.length < 2) return processedBscanData;
    return svdFilter(processedBscanData, mapSvdK, mapSvdStrength);
  }, [processedBscanData, mapSvdEnabled, mapSvdK, mapSvdStrength]);

  // Apply BG subtraction to the live SFCW result: model or captured reference,
  // never both. Complex (vector) subtraction in all cases.
  //
  // Every way this can decline to subtract now reports itself (Phase 0.4).
  // Previously each one either warned to a console nobody has open or, in the
  // out-of-span case, did not check at all -- inferInterpModel silently clamps
  // to the nearest captured knot, so a standoff well outside the model's range
  // produced a confident-looking subtraction against a background measured
  // somewhere else entirely. That is indistinguishable on screen from a working
  // subtraction, and is a prime suspect for the false targets.
  const sfcwProcessed = useMemo(() => {
    const noop = (reason) => ({ result: sfcwResult, diag: { applied: false, reason } });
    if (!sfcwResult) return { result: sfcwResult, diag: null };
    if (!sfcwResult.h_cal_real || !sfcwResult.h_cal_imag) return noop('sweep carries no h_cal');

    const numSteps = sfcwResult.h_cal_real.length;
    let bgReal = null;
    let bgImag = null;
    const diag = { applied: true, reason: null, source: null, clamped: false, standoffMm: sfcwStandoffMm };

    if (sfcwBgModel) {
      diag.source = 'model';
      if (numSteps !== sfcwBgModel.sfcwParams.numSteps) {
        return noop(`numSteps mismatch: sweep ${numSteps} vs model ${sfcwBgModel.sfcwParams.numSteps}`);
      }
      if (sfcwStandoffMm == null) return noop('no lidar standoff available');
      // Out-of-span check, matching CscanPanel.jsx. The model is only valid
      // between its first and last captured knot; outside that the inference
      // clamps, so the "background" it returns is not for this standoff.
      const md = sfcwBgModel.d;
      if (Array.isArray(md) && md.length) {
        diag.modelSpan = { min: md[0], max: md[md.length - 1] };
        if (sfcwStandoffMm < md[0] || sfcwStandoffMm > md[md.length - 1]) {
          diag.clamped = true;
          diag.clampedBy = sfcwStandoffMm < md[0]
            ? md[0] - sfcwStandoffMm
            : sfcwStandoffMm - md[md.length - 1];
        }
      }
      ({ bgReal, bgImag } = inferBgModel(sfcwBgModel, sfcwStandoffMm, numSteps));
    } else if (sfcwBgRef) {
      diag.source = 'ref';
      if (sfcwBgRef.h_cal_real.length !== numSteps) {
        return noop(`numSteps mismatch: sweep ${numSteps} vs ref ${sfcwBgRef.h_cal_real.length}`);
      }
      bgReal = sfcwBgRef.h_cal_real;
      bgImag = sfcwBgRef.h_cal_imag;
    } else {
      return noop('no background selected');
    }

    const subReal = new Array(numSteps);
    const subImag = new Array(numSteps);
    for (let i = 0; i < numSteps; i++) {
      subReal[i] = sfcwResult.h_cal_real[i] - bgReal[i];
      subImag[i] = sfcwResult.h_cal_imag[i] - bgImag[i];
    }

    const rp = computeRangeProfile(subReal, subImag, numSteps, sfcwResult.step_size, sfcwResult.range_offset);
    // SfcwDisplay recomputes its own profile from h_cal_* (windowing/range comp),
    // so the subtracted spectrum must replace them or the subtraction is discarded.
    return {
      result: {
        ...sfcwResult,
        h_cal_real: subReal,
        h_cal_imag: subImag,
        magnitudes: rp.magnitudes,
        distances: rp.distances,
      },
      diag,
    };
  }, [sfcwResult, sfcwBgModel, sfcwBgRef, sfcwStandoffMm]);

  const processedSfcwResult = sfcwProcessed.result;

  // Running tally of how often the model was asked for a standoff it never saw.
  // A single clamped sweep is easy to miss; a clamp *fraction* is not, and it
  // is the difference between "the model is wrong" and "the model is being
  // asked the wrong question".
  //
  // Kept in a ref and mutated, not in state -- the same reason sfcwDynamicScale
  // is a ref: sweeps arrive at 3-6 Hz and a setState here would add a second
  // render pass to every one of them. App already re-renders per sweep (see
  // setSfcwResult below), so a snapshot taken during render is always current
  // to within one sweep, which is ample for a running tally.
  const sfcwBgStatsRef = useRef({ total: 0, clamped: 0, skipped: 0 });
  const [, bumpBgStats] = useReducer(x => x + 1, 0);
  const sfcwBgDiag = sfcwProcessed.diag;
  useEffect(() => {
    if (!sfcwBgDiag) return;
    // Only count sweeps where a background was actually selected; "no
    // background selected" is not a failure to report.
    if (!sfcwBgDiag.applied && sfcwBgDiag.reason === 'no background selected') return;
    const st = sfcwBgStatsRef.current;
    st.total += 1;
    if (sfcwBgDiag.clamped) st.clamped += 1;
    if (!sfcwBgDiag.applied) st.skipped += 1;
  }, [sfcwBgDiag]);
  const sfcwBgStats = { ...sfcwBgStatsRef.current };

  const resetSfcwBgStats = useCallback(() => {
    sfcwBgStatsRef.current = { total: 0, clamped: 0, skipped: 0 };
    bumpBgStats();  // nothing else would repaint if the sweep is stopped
  }, []);

  // IMU WebSocket
  const handleImuMessage = useCallback((msg) => {
    imuCountRef.current++;
    setImuData(msg);
    if (msg.lidar !== null && msg.lidar !== undefined) {
      setLidarMm(msg.lidar);
      // Only accumulate genuinely-new readings. A Pi without `lidar_seq`
      // (pre-2026-08-28 stream.py) reports undefined, in which case every
      // packet is accumulated -- the old behaviour, so the panel degrades
      // rather than silently recording zero samples.
      const seq = msg.lidar_seq;
      if (seq === undefined || seq === null || seq !== lidarLastSeqRef.current) {
        lidarLastSeqRef.current = seq;
        lidarAccumRef.current.push(msg.lidar);
      }
    }
    // Pose from the gravity vector. accel is body-frame [forward, left, up] in
    // g (see CONTEXT.md), so this is tilt only -- no yaw, which gravity cannot
    // observe. Good enough to answer "did the head tilt between captures".
    const a = msg.accel;
    if (Array.isArray(a) && a.length === 3 && a.every(v => typeof v === 'number')) {
      const [fwd, left, up] = a;
      poseAccumRef.current.push({
        roll: Math.atan2(left, up) * 180 / Math.PI,
        pitch: Math.atan2(-fwd, Math.hypot(left, up)) * 180 / Math.PI,
      });
    }
  }, []);

  const imuUrl = piIp ? `ws://${piIp}:9001` : null;
  const { status: imuStatus, connect: connectImu, disconnect: disconnectImu } = useWebSocket(imuUrl, handleImuMessage);

  // SDR WebSocket (RF Calib + SFCW share this connection)
  const handleSdrMessage = useCallback((msg) => {
    if (msg.type === 'status') {
      setSdrStatus(msg);
      setTxActive(msg.tx_active);
      setRxActive(msg.rx_active);
      if (!msg.rx_active) {
        setRxSamplesAnt([]);
        setRxSamplesRef([]);
        setFftDataAnt(null);
        setFftDataRef(null);
      }
    } else if (msg.type === 'rx_data') {
      setRxSamplesAnt(msg.antenna.i);
      setRxSamplesRef(msg.reference.i);
    } else if (msg.type === 'rx_fft') {
      const freqSpan = msg.freq_span || 2000000;
      setFftDataAnt({ magnitudes: msg.antenna.magnitudes, freq_span: freqSpan });
      setFftDataRef({ magnitudes: msg.reference.magnitudes, freq_span: freqSpan });
    } else if (msg.type === 'sfcw_status') {
      setSfcwRunning(msg.running);
      setSfcwStatus(msg);
    } else if (msg.type === 'sfcw_result') {
      // Averaged lidar standoff for this sweep, plus the provenance needed to
      // judge it: how many DISTINCT readings went into the mean and how far
      // they spread.
      //
      // Recorded for attribution, not because standoff noise is the limit --
      // it measurably is not. Scoring the same 24-position set four ways
      // (2026-08-28) put the benchmark-to-live gap at 5.3 dB, of which standoff
      // noise owns 0.37 dB and single-sweep SNR owns 5.16 dB. What these fields
      // are actually for is telling a bad standoff apart from a bad model when
      // a sweep does cancel poorly, which was previously impossible: lidar_n
      // near zero means the standoff is stale, not that the model is wrong.
      const accum = lidarAccumRef.current;
      const lidarN = accum.length;
      const avgLidarMm = lidarN > 0
        ? accum.reduce((s, v) => s + v, 0) / lidarN
        : null;
      const lidarStd = lidarN > 1
        ? Math.sqrt(accum.reduce((s, v) => s + (v - avgLidarMm) ** 2, 0) / (lidarN - 1))
        : null;
      const standoffMm = avgLidarMm !== null ? avgLidarMm - lidarOffsetRef.current : null;
      lidarAccumRef.current = [];

      const pose = poseAccumRef.current;
      const poseN = pose.length;
      const rollDeg = poseN > 0 ? pose.reduce((s, v) => s + v.roll, 0) / poseN : null;
      const pitchDeg = poseN > 0 ? pose.reduce((s, v) => s + v.pitch, 0) / poseN : null;
      poseAccumRef.current = [];

      // One object, spread into every record below, so the sweep record, the
      // C-scan cell and the BG-model sample can never drift apart.
      const provenance = {
        lidar_standoff_mm: standoffMm,
        lidar_n: lidarN,
        lidar_std: lidarStd,
        lidar_offset_mm: lidarOffsetRef.current,
        roll_deg: rollDeg,
        pitch_deg: pitchDeg,
      };
      setSfcwLidarProvenance(provenance);

      // Always update live display
      setSfcwResult(msg);
      setSfcwStandoffMm(standoffMm);

      // SFCW BG reference: first sweep after the button press becomes the reference
      if (sfcwBgCaptureRef.current && msg.h_cal_real && msg.h_cal_imag) {
        setSfcwBgRef({
          h_cal_real: [...msg.h_cal_real],
          h_cal_imag: [...msg.h_cal_imag],
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
          ...provenance,
        });
        sfcwBgCaptureRef.current = false;
        setSfcwBgCapturing(false);
      }

      // C-scan capture: the first sweep after the button press is the cell.
      // The cell is resolved from the capture index along the snake path and
      // stored on the record, so editing the grid later never relabels it.
      if (bscanCaptureRef.current) {
        const grid = bscanParamsRef.current;
        setBscanData(prev => {
          const cell = cellForIndex(prev.length, grid.hCount);
          return [...prev, {
            magnitudes: [...msg.magnitudes],
            distances: [...msg.distances],
            h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
            h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
            num_steps: msg.num_steps,
            step_size: msg.step_size,
            range_offset: msg.range_offset,
            ...provenance,
            grid_ix: cell.ix,
            grid_iy: cell.iy,
            x_cm: cell.ix * grid.hStep,
            y_cm: cell.iy * grid.vStep,
          }];
        });
        bscanCaptureRef.current = false;
        setBscanCapturing(false);
      }

      // B-scan BG reference: likewise tagged groundstation-side
      if (bscanBgCaptureRef.current && msg.h_cal_real && msg.h_cal_imag) {
        setBscanBgRef({
          h_cal_real: [...msg.h_cal_real],
          h_cal_imag: [...msg.h_cal_imag],
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
          ...provenance,
        });
        bscanBgCaptureRef.current = false;
        setBscanBgCapturing(false);
      }
      if (bgModelAccumRef.current) {
        const accum = bgModelAccumRef.current;
        accum.samples.push({
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          ...provenance,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
          timestamp: msg.timestamp,
        });
        setBgModelAccumCount(accum.samples.length);

        if (accum.samples.length >= accum.target) {
          const capture = { samples: accum.samples, stats: computeCaptureStats(accum.samples) };
          setBgModelCaptures(prev => [...prev, capture]);
          bgModelAccumRef.current = null;
          setBgModelCapturing(false);
          setBgModelAccumCount(0);
        }
      }
      if (bgModelTestRef.current) {
        const test = bgModelTestRef.current;
        test.samples.push({
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          ...provenance,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
        });
        setBgModelTestCount(test.samples.length);

        if (test.samples.length >= 5) {
          const result = runPhaseUnwindTest(test.samples, sfcwParamsRef.current);
          setBgModelTestResult(result);
          bgModelTestRef.current = null;
          setBgModelTesting(false);
          setBgModelTestCount(0);
        }
      }
      setSfcwProgress(null);
    } else if (msg.type === 'sfcw_progress') {
      setSfcwProgress(msg);
    } else if (msg.type === 'sfcw_error') {
      setSfcwRunning(false);
      setSfcwProgress(null);
      bscanCaptureRef.current = false;
      bscanBgCaptureRef.current = false;
      setBscanCapturing(false);
      setBscanBgCapturing(false);
    } else if (msg.type === 'coherence_result') {
      setCoherenceResult(msg);
      setSfcwRunning(false);
    }
  }, []);

  const sdrUrl = piIp ? `ws://${piIp}:9003` : null;
  const { status: sdrConnectionStatus, send: sendSdr, connect: connectSdr, disconnect: disconnectSdr } = useWebSocket(sdrUrl, handleSdrMessage);

  // The Pi keeps its own SFCW defaults, so anything the panel shows is a guess
  // until we push. Sync on connect and again before every sweep, so the panel is
  // always the source of truth and the two sides cannot drift apart silently.
  const sendSfcwParams = useCallback(() => {
    const p = sfcwParamsRef.current;
    sendSdr({
      cmd: 'sfcw_set_params',
      start_freq_mhz: p.startFreq,
      stop_freq_mhz: p.stopFreq,
      step_size_mhz: p.stepSize,
      num_buffers: p.numBuffers,
      settle_count: p.settleCount,
      tx1_gain: p.tx1Gain,
      rx1_gain: p.rx1Gain,
      range_offset: p.rangeOffset,
    });
  }, [sendSdr]);

  useEffect(() => {
    if (sdrConnectionStatus === 'connected') sendSfcwParams();
  }, [sdrConnectionStatus, sendSfcwParams]);

  const handleBscanAction = useCallback((action) => {
    if (action === 'start_session') {
      if (sfcwRunning) return;
      sendSfcwParams();
      sendSdr({ cmd: 'sfcw_start' });
    } else if (action === 'stop_session') {
      sendSdr({ cmd: 'sfcw_stop' });
    } else if (action === 'add_scan') {
      // The Pi has no notion of a B-scan; the next sweep it sends is the capture.
      setBscanCapturing(true);
      bscanCaptureRef.current = true;
    } else if (action === 'new') {
      setBscanData([]);
    } else if (action === 'undo') {
      setBscanData(prev => prev.slice(0, -1));
    } else if (action === 'export') {
      const exportData = {
        version: 5,
        timestamp: new Date().toISOString(),
        params: bscanParams,
        sfcwParams: sfcwParams,
        lidarAntennaOffsetMm: lidarOffsetMm,
        data: bscanData,
        bgRef: bscanBgRef,
        bgModelName: bscanBgModel ? (bscanBgModel.name || null) : null,
      };
      const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cscan_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (action === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (imported.data && Array.isArray(imported.data)) {
              setBscanData(imported.data);
              if (imported.bgRef) {
                setBscanBgModel(null);
                setBscanBgRef(imported.bgRef);
              }
              if (imported.params) {
                // v3 and earlier stored the depth extent as a wall thickness;
                // v4 and earlier were a single line (stepSize / numPositions),
                // which maps onto a one-row grid.
                const {
                  stepSize, numPositions, maxDepth, wallThickness,
                  hCount, hStep, vCount, vStep, gateStart, gateEnd, metric,
                } = imported.params;
                const depth = maxDepth != null ? maxDepth : wallThickness;
                setBscanParams(prev => ({
                  ...prev,
                  ...(depth != null && { maxDepth: depth }),
                  ...(stepSize != null && { hStep: stepSize }),
                  ...(numPositions != null && { hCount: numPositions, vCount: 1 }),
                  ...(hCount != null && { hCount }),
                  ...(hStep != null && { hStep }),
                  ...(vCount != null && { vCount }),
                  ...(vStep != null && { vStep }),
                  ...(gateStart != null && { gateStart }),
                  ...(gateEnd != null && { gateEnd }),
                  ...(metric != null && { metric }),
                }));
              }
            }
          } catch (err) {
            console.error('Failed to import B-scan:', err);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }
  }, [sendSdr, sendSfcwParams, sfcwRunning, bscanData, bscanParams, sfcwParams, bscanBgRef, bscanBgModel]);

  const handleBgModelAction = useCallback((action, payload) => {
    if (action === 'start_session') {
      if (sfcwRunning) return;
      sendSfcwParams();
      sendSdr({ cmd: 'sfcw_start' });
    } else if (action === 'stop_session') {
      sendSdr({ cmd: 'sfcw_stop' });
    } else if (action === 'capture') {
      setBgModelCapturing(true);
      bgModelAccumRef.current = { samples: [], target: bgModelSweepsPerCapture };
    } else if (action === 'undo') {
      setBgModelCaptures(prev => prev.slice(0, -1));
    } else if (action === 'clear') {
      setBgModelCaptures([]);
    } else if (action === 'build') {
      // One training sample per position, using the coherent mean across that
      // position's sweeps. The replicas are the same standoff measured N times,
      // so feeding them individually adds no information — it just costs N x the
      // epochs and regresses to this mean anyway.
      const allSamples = bgModelCaptures.map(c => (
        c.stats
          ? {
              h_cal_real: c.stats.h_mean_real,
              h_cal_imag: c.stats.h_mean_imag,
              lidar_standoff_mm: c.stats.standoffMm,
              num_steps: c.stats.numSteps,
            }
          : c.samples[0]
      )).filter(s => s && s.h_cal_real && s.lidar_standoff_mm != null);
      if (allSamples.length < 5) return;
      // Geometry stamp. The model is a function of standoff, and standoff is
      // `lidar_reading - lidarOffsetMm`, so a model is only valid under the
      // offset it was built with -- a change between training and inference
      // shifts every query, and shifted past the captured span it clamps
      // silently (~20 dB, and worse than useless past ~20 mm out). The full
      // sfcwParams go along because gains, step size and settle count all
      // change what h_cal actually is.
      bgModelWorker.startTraining(allSamples, sfcwParams, {
        geometry: {
          lidarAntennaOffsetMm: lidarOffsetMm,
          sfcwParams: { ...sfcwParams },
          builtAt: new Date().toISOString(),
        },
      });
    } else if (action === 'save_model') {
      if (!bgModelWorker.resultRef.current || !payload) return;
      const modelData = {
        ...bgModelWorker.resultRef.current,
        name: payload,
        created: new Date().toISOString(),
      };
      fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelData),
      }).then(r => r.json()).then(res => {
        if (res.success) bgModelWorker.reset();
      }).catch(err => console.error('Failed to save model:', err));
    } else if (action === 'export') {
      if (bgModelCaptures.length === 0) return;
      // v2 hoists the fields that repeat identically on every sweep and stores
      // per-position stats alongside the raw sweeps, so the file is directly
      // usable for offline fitting without recomputation.
      const ref = bgModelCaptures[0].samples[0] || {};
      const exportData = {
        version: 2,
        type: 'bgmodel_training_data',
        timestamp: new Date().toISOString(),
        sfcwParams: sfcwParams,
        lidarAntennaOffsetMm: lidarOffsetMm,
        sweepsPerCapture: bgModelSweepsPerCapture,
        common: {
          num_steps: ref.num_steps,
          step_size: ref.step_size,
          range_offset: ref.range_offset,
        },
        captures: bgModelCaptures.map(c => ({
          stats: c.stats || computeCaptureStats(c.samples),
          standoffs: c.samples.map(s => s.lidar_standoff_mm),
          real: c.samples.map(s => s.h_cal_real),
          imag: c.samples.map(s => s.h_cal_imag),
        })),
      };
      const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bgmodel_${bgModelCaptures.length}pos_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (action === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (imported.type !== 'bgmodel_training_data' || !Array.isArray(imported.captures)) return;
            const common = imported.common || {};
            const caps = imported.captures.map(c => {
              // v1 stored a plain samples array; v2 stores hoisted columns
              const samples = c.samples || c.real.map((r, i) => ({
                h_cal_real: r,
                h_cal_imag: c.imag[i],
                lidar_standoff_mm: c.standoffs[i],
                num_steps: common.num_steps,
                step_size: common.step_size,
                range_offset: common.range_offset,
              }));
              return { samples, stats: c.stats || computeCaptureStats(samples) };
            });
            setBgModelCaptures(caps);
          } catch (err) {
            console.error('Failed to import BG model data:', err);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    } else if (action === 'test_phase') {
      setBgModelTesting(true);
      setBgModelTestResult(null);
      bgModelTestRef.current = { samples: [] };
    }
  }, [sendSdr, sendSfcwParams, sfcwRunning, bgModelCaptures, sfcwParams, bgModelSweepsPerCapture, bgModelWorker.startTraining, bgModelWorker.reset, bgModelWorker.resultRef]);

  // Rate counter interval
  const rateIntervalRef = useRef(null);

  const handleConnect = useCallback(() => {
    if (!piIp.trim()) return;
    localStorage.setItem('pi_ip', piIp);
    connectImu();
    connectSdr();

    if (rateIntervalRef.current) clearInterval(rateIntervalRef.current);
    rateIntervalRef.current = setInterval(() => {
      setImuRate(imuCountRef.current);
      imuCountRef.current = 0;
    }, 1000);
  }, [piIp, connectImu, connectSdr]);

  const handleDisconnect = useCallback(() => {
    disconnectImu();
    disconnectSdr();
    if (rateIntervalRef.current) { clearInterval(rateIntervalRef.current); rateIntervalRef.current = null; }
    setImuRate(0);
  }, [disconnectImu, disconnectSdr]);

  const isConnected = imuStatus === 'connected';

  // Auto-connect on mount if a saved IP exists
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (!autoConnectedRef.current && piIp.trim()) {
      autoConnectedRef.current = true;
      handleConnect();
    }
  }, [handleConnect, piIp]);

  return (
    <div className="flex w-full min-h-screen bg-black">
      <Sidebar
        isConnected={isConnected}
        activePanel={activePanel}
        onActivePanelChange={setActivePanel}
        piIp={piIp}
        onPiIpChange={setPiIp}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        imuRate={imuRate}
        imuData={imuData}
        lidarMm={lidarMm}
        sdrConnected={sdrConnectionStatus === 'connected'}
        txActive={txActive}
        rxActive={rxActive}
        showFFT={showFFT}
        onToggleFFT={setShowFFT}
        graphPaused={graphPaused}
        onTogglePause={setGraphPaused}
        sendSdr={sendSdr}
        sfcwRunning={sfcwRunning}
        sfcwStatus={sfcwStatus}
        sfcwParams={sfcwParams}
        onSfcwParamsChange={setSfcwParams}
        sfcwResult={processedSfcwResult}
        coherenceResult={coherenceResult}
        sfcwRangeScale={sfcwRangeScale}
        onSfcwRangeScaleChange={setSfcwRangeScale}
        sfcwScaleRange={sfcwScaleRange}
        onSfcwScaleRangeChange={setSfcwScaleRange}
        getSfcwDynamicScale={getSfcwDynamicScale}
        sfcwBgModel={sfcwBgModel}
        sfcwBgRef={sfcwBgRef}
        sfcwBgCapturing={sfcwBgCapturing}
        sfcwBgDiag={sfcwBgDiag}
        sfcwBgStats={sfcwBgStats}
        onResetSfcwBgStats={resetSfcwBgStats}
        sfcwLidarProvenance={sfcwLidarProvenance}
        onCaptureSfcwBg={handleSfcwCaptureBg}
        onLoadSfcwBgModel={handleSfcwLoadBgModel}
        onClearSfcwBg={handleSfcwClearBg}
        bscanData={bscanData}
        bscanCapturing={bscanCapturing}
        bscanBgRef={bscanBgRef}
        bscanBgModel={bscanBgModel}
        bscanBgCapturing={bscanBgCapturing}
        onCaptureBscanBg={handleBscanCaptureBg}
        onLoadBscanBgModel={handleBscanLoadBgModel}
        onClearBscanBg={handleBscanClearBg}
        lidarOffsetMm={lidarOffsetMm}
        onLidarOffsetChange={setLidarOffsetMm}
        bgApplied={bgApplied}
        onBgAppliedChange={setBgApplied}
        bscanParams={bscanParams}
        onBscanParamsChange={setBscanParams}
        onBscanAction={handleBscanAction}
        bscanScaleMode={bscanScaleMode}
        onBscanScaleModeChange={setBscanScaleMode}
        bscanDisplayMode={bscanDisplayMode}
        onBscanDisplayModeChange={setBscanDisplayMode}
        bscanScaleRange={bscanScaleRange}
        onBscanScaleRangeChange={setBscanScaleRange}
        sarBscanData={sarBscanInput}
        sarResult={sarResult}
        sarProgress={sarProgress}
        sarBgEnabled={sarBgEnabled}
        onSarBgEnabledChange={setSarBgEnabled}
        sarSvdEnabled={sarSvdEnabled}
        sarSvdK={sarSvdK}
        sarSvdStrength={sarSvdStrength}
        onSarSvdEnabledChange={setSarSvdEnabled}
        onSarSvdKChange={setSarSvdK}
        onSarSvdStrengthChange={setSarSvdStrength}
        sarScaleMode={sarScaleMode}
        onSarScaleModeChange={setSarScaleMode}
        sarAperture={sarAperture}
        onSarApertureChange={setSarAperture}
        sarCoherent={sarCoherent}
        onSarCoherentChange={setSarCoherent}
        sarDynRange={sarDynRange}
        onSarDynRangeChange={setSarDynRange}
        mapBscanData={mapBscanData}
        mapGateStart={mapGateStart}
        mapGateEnd={mapGateEnd}
        onMapGateStartChange={setMapGateStart}
        onMapGateEndChange={setMapGateEnd}
        mapDynRange={mapDynRange}
        onMapDynRangeChange={setMapDynRange}
        mapMetric={mapMetric}
        onMapMetricChange={setMapMetric}
        mapFocusEnabled={mapFocusEnabled}
        mapFocusAperture={mapFocusAperture}
        onMapFocusEnabledChange={setMapFocusEnabled}
        onMapFocusApertureChange={setMapFocusAperture}
        mapSvdEnabled={mapSvdEnabled}
        mapSvdK={mapSvdK}
        mapSvdStrength={mapSvdStrength}
        onMapSvdEnabledChange={setMapSvdEnabled}
        onMapSvdKChange={setMapSvdK}
        onMapSvdStrengthChange={setMapSvdStrength}
        bgModelCaptures={bgModelCaptures}
        bgModelCapturing={bgModelCapturing}
        bgModelAccumCount={bgModelAccumCount}
        bgModelTesting={bgModelTesting}
        bgModelTestCount={bgModelTestCount}
        bgModelTestResult={bgModelTestResult}
        bgModelTraining={bgModelWorker.trainingState}
        bgModelTrainProgress={bgModelWorker.progress}
        bgModelTrainResult={bgModelWorker.result}
        bgModelTrainError={bgModelWorker.error}
        bgModelSweepsPerCapture={bgModelSweepsPerCapture}
        onBgModelSweepsChange={setBgModelSweepsPerCapture}
        onBgModelAction={handleBgModelAction}
        imagingSnapshot={imagingSnapshot}
        imagingSnapshotName={imagingSnapshotName}
        onLoadImagingSnapshot={handleLoadImagingSnapshot}
        onClearImagingSnapshot={handleClearImagingSnapshot}
        imagingEffect={imagingEffect}
        onImagingEffectChange={setImagingEffect}
        imagingParams={imagingParams}
        onImagingParamsChange={setImagingParams}
      />
      <Viewport
        activePanel={activePanel}
        isConnected={isConnected}
        imuData={imuData}
        txActive={txActive}
        rxActive={rxActive}
        rxSamplesAnt={rxSamplesAnt}
        rxSamplesRef={rxSamplesRef}
        fftDataAnt={fftDataAnt}
        fftDataRef={fftDataRef}
        showFFT={showFFT}
        graphPaused={graphPaused}
        sfcwResult={processedSfcwResult}
        sfcwProgress={sfcwProgress}
        sfcwRunning={sfcwRunning}
        sfcwRangeScale={sfcwRangeScale}
        sfcwScaleRange={sfcwScaleRange}
        onSfcwScaleRangeChange={setSfcwScaleRange}
        onSfcwDynamicScale={handleSfcwDynamicScale}
        bscanData={processedBscanData}
        bscanBgDisplay={bscanBgDisplay}
        bscanAlignShifts={alignShifts}
        bscanParams={bscanParams}
        bscanCapturing={bscanCapturing}
        bscanScaleMode={bscanScaleMode}
        bscanDisplayMode={bscanDisplayMode}
        bscanScaleRange={bscanScaleRange}
        sarResult={sarResult}
        sarProgress={sarProgress}
        sarScaleMode={sarScaleMode}
        sarDynRange={sarDynRange}
        mapBscanData={mapBscanData}
        mapGateStart={mapGateStart}
        mapGateEnd={mapGateEnd}
        mapDynRange={mapDynRange}
        mapMetric={mapMetric}
        mapStepSize={bscanParams.hStep}
        mapFocusEnabled={mapFocusEnabled}
        mapFocusAperture={mapFocusAperture}
        bgModelCaptures={bgModelCaptures}
        bgModelCapturing={bgModelCapturing}
        bgModelStopFreq={sfcwParams.stopFreq}
        imagingSnapshot={imagingSnapshot}
        imagingEffect={imagingEffect}
        imagingParams={imagingParams}
      />
    </div>
  );
}
