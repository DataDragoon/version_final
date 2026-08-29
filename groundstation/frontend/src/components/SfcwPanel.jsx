import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';


const LIDAR_AVG_WINDOW = 20;

function fmtDeg(v) {
  return v == null || !isFinite(v) ? '—' : `${v.toFixed(1)}°`;
}

// Does a loaded model's build-time geometry still describe the current rig?
// A model is indexed by `lidar_reading - offset`, so a changed offset shifts
// every inference by that difference. The danger is not the shift itself but
// where it lands: shifted far enough, every query falls outside the model's
// captured span and silently clamps, which costs ~20 dB and past ~20 mm makes
// the subtraction add energy rather than remove it. Sweep params are checked
// for the same reason -- they change what h_cal is.
function geometryMismatch(bgModel, lidarOffsetMm, params) {
  if (!bgModel) return null;
  const g = bgModel.geometry;
  if (!g) return { unknown: true };
  const out = [];
  if (g.lidarAntennaOffsetMm != null && lidarOffsetMm != null
      && Math.abs(g.lidarAntennaOffsetMm - lidarOffsetMm) > 0.01) {
    out.push(`offset ${g.lidarAntennaOffsetMm} mm → ${lidarOffsetMm} mm`);
  }
  const gp = g.sfcwParams || {};
  for (const k of ['startFreq', 'stopFreq', 'stepSize', 'tx1Gain', 'rx1Gain', 'numBuffers', 'settleCount']) {
    if (gp[k] != null && params?.[k] != null && gp[k] !== params[k]) {
      out.push(`${k} ${gp[k]} → ${params[k]}`);
    }
  }
  return out.length ? { fields: out } : null;
}

// Must match pi/radar/sfcw_engine.py: _start_tx_rx() captures n = 4096 samples
// per buffer at the 10 Msps set in _configure_hardware().
const BUFFER_SAMPLES = 4096;
const SAMPLE_RATE = 10_000_000;
const BUFFER_TIME_MS = (BUFFER_SAMPLES / SAMPLE_RATE) * 1000;

// Mirrors COHERENCE_SWEEP_COUNT in pi/radar/sfcw_engine.py — the engine is the source
// of truth, this is only the button label. Metrics come back for consecutive pairs,
// so there are COHERENCE_SWEEPS - 1 of them.
const COHERENCE_SWEEPS = 100;
// Too many pairs to print in full; show this many and count the rest.
const COHERENCE_LIST_SHOWN = 12;

function fmtList(vals) {
  if (!vals?.length) return '—';
  const head = vals.slice(0, COHERENCE_LIST_SHOWN).map(v => v.toFixed(3)).join(', ');
  const rest = vals.length - COHERENCE_LIST_SHOWN;
  return rest > 0 ? `${head} … +${rest} more` : head;
}

function fmtWorst(vals) {
  if (!vals?.length) return '—';
  return Math.min(...vals).toFixed(3);
}

export default function SfcwPanel({ isConnected, sdrConnected, sfcwRunning, sfcwStatus, sendSdr, params, onParamsChange, coherenceResult, rangeScale, onRangeScaleChange, scaleRange, onScaleRangeChange, getDynamicScale, lidarMm, bgModel, bgRef, bgCapturing, onCaptureBg, onLoadBgModel, onClearBg,
  bgDiag, bgStats, onResetBgStats, lidarProvenance, lidarOffsetMm, onLidarOffsetChange }) {
  const { startFreq, stopFreq, stepSize, numBuffers, settleCount, tx1Gain, rx1Gain, rangeOffset } = params;
  const [coherenceRunning, setCoherenceRunning] = useState(false);
  const lidarBuf = useRef([]);
  const [lidarAvg, setLidarAvg] = useState(null);
  const [modelList, setModelList] = useState(null);
  const [modelListOpen, setModelListOpen] = useState(false);

  useEffect(() => {
    if (coherenceResult) setCoherenceRunning(false);
  }, [coherenceResult]);

  useEffect(() => {
    if (lidarMm == null) return;
    const buf = lidarBuf.current;
    buf.push(lidarMm);
    if (buf.length > LIDAR_AVG_WINDOW) buf.shift();
    const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
    setLidarAvg(avg);
  }, [lidarMm]);

  const geoMismatch = geometryMismatch(bgModel, lidarOffsetMm, params);

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const fetchModels = useCallback(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => { setModelList(Array.isArray(data) ? data : []); setModelListOpen(true); })
      .catch(() => setModelList([]));
  }, []);

  const loadModel = useCallback((filename) => {
    fetch(`/api/models/${filename}`)
      .then(r => r.json())
      .then(model => {
        onLoadBgModel(model);
        setModelListOpen(false);
      })
      .catch(err => console.error('Failed to load model:', err));
  }, [onLoadBgModel]);

  const canActivate = isConnected && sdrConnected;

  const sendParams = (overrides = {}) => {
    sendSdr({
      cmd: 'sfcw_set_params',
      start_freq_mhz: overrides.startFreq ?? startFreq,
      stop_freq_mhz: overrides.stopFreq ?? stopFreq,
      step_size_mhz: overrides.stepSize ?? stepSize,
      num_buffers: overrides.numBuffers ?? numBuffers,
      settle_count: overrides.settleCount ?? settleCount,
      tx1_gain: overrides.tx1Gain ?? tx1Gain,
      rx1_gain: overrides.rx1Gain ?? rx1Gain,
      range_offset: overrides.rangeOffset ?? rangeOffset,
    });
  };

  // Amplitude scaling. The display owns the live dynamic limits, so handing
  // over to manual seeds the fields from whatever is on screen right now —
  // the colours and the Y axis must not jump on the toggle.
  const isDbScale = scaleRange.isDb !== false;
  const fmtScale = (v) => (isDbScale ? (Math.round(v * 10) / 10).toString() : Number(v).toExponential(2));
  const scaleUnit = isDbScale ? 'dB' : '';
  const scaleGap = isDbScale ? 1 : 1e-12;

  const toManualScale = () => {
    const live = getDynamicScale ? getDynamicScale() : null;
    if (!live || !isFinite(live.min) || !isFinite(live.max) || live.max <= live.min) {
      return { dynamic: false, min: scaleRange.min, max: scaleRange.max, isDb: scaleRange.isDb !== false };
    }
    return { dynamic: false, min: live.min, max: live.max, isDb: live.isDb !== false };
  };

  const numSteps = Math.floor((stopFreq - startFreq) / stepSize) + 1;
  const bandwidth = (stopFreq - startFreq) * 1e6;
  const rangeRes = bandwidth > 0 ? (299792458 / (2 * bandwidth)) : Infinity;
  const maxRange = stepSize > 0 ? (299792458 / (4 * stepSize * 1e6) - rangeOffset) : Infinity;
  // "0-3m" display mode never shows past the sweep's actual unambiguous range
  // (matches sfcw_engine.py _process_h_cal's displayed_range_max) — no point
  // sizing the axis past where real data can ever land.
  const bigRangeMax = Math.max(0.5, Math.min(maxRange, 3));
  const captureTimeMs = numBuffers * BUFFER_TIME_MS;
  // Per-step wait is (settleCount + numBuffers) buffer arrivals — see
  // pi/radar/sfcw_engine.py _sweep_core. Real time tends to run a bit under this
  // because RX callbacks overlap with per-step Python overhead.
  const sweepTime = numSteps * (settleCount + numBuffers) * BUFFER_TIME_MS / 1000;

  return (
    <>
      {/* Sweep Range */}
      <Section label="Sweep Range">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Start"
            value={startFreq}
            unit="MHz"
            onChange={(v) => { update('startFreq', v); sendParams({ startFreq: v }); }}
            min={2000}
            max={5000}
          />
          <EditableField
            label="Stop"
            value={stopFreq}
            unit="MHz"
            onChange={(v) => { update('stopFreq', v); sendParams({ stopFreq: v }); }}
            min={2000}
            max={5000}
          />
        </div>
      </Section>

      {/* Step Configuration */}
      <Section label="Step Config">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Step Size"
            value={stepSize}
            unit="MHz"
            onChange={(v) => { update('stepSize', v); sendParams({ stepSize: v }); }}
            min={20}
            max={500}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-2">
            <EditableField
              label="Buffers"
              value={numBuffers}
              unit="x4096 smp"
              onChange={(v) => { update('numBuffers', v); sendParams({ numBuffers: v }); }}
              min={1}
              max={64}
            />
            <EditableField
              label="Settle"
              value={settleCount}
              unit="buffers"
              onChange={(v) => { update('settleCount', v); sendParams({ settleCount: v }); }}
              min={0}
              max={30}
            />
          </div>
          <span className="text-[9px] text-[#333333] leading-tight px-1">
            {captureTimeMs.toFixed(2)} ms capture per step ({(numBuffers * BUFFER_SAMPLES).toLocaleString()} samples),
            averaged over {numBuffers} buffer{numBuffers === 1 ? '' : 's'} — {settleCount === 0
              ? 'no buffers discarded after retune'
              : `retune settle discards ${settleCount} buffers first`}
          </span>
        </div>
        <EditableField
          label="Range Offset"
          value={rangeOffset}
          unit="m"
          onChange={(v) => { update('rangeOffset', v); sendParams({ rangeOffset: v }); }}
          min={0}
          max={10}
        />
      </Section>

      {/* Distance */}
      <Section label="Standoff">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-3 py-2 rounded-xl border border-white/8 bg-[#0a0a0a]/60">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Distance</span>
            <span className="text-base font-bold font-mono text-white">
              {lidarAvg != null ? lidarAvg.toFixed(1) : '—'} <span className="text-xs font-semibold text-[#888888]">mm</span>
            </span>
          </div>
          {/* Provenance of the standoff the last sweep actually used. `n` is
              DISTINCT lidar readings (deduped by lidar_seq), not packets --
              measured 5.3 per 250 ms sweep at the 20 Hz poll rate, vs 13.0
              packets before deduping. sigma is the spread of those samples
              (the sweep uses their mean, whose error is smaller).

              There is deliberately no "suppression ceiling" tile here. The
              obvious one -- treat sigma as a phase error on a single echo at
              12 deg/mm -- was measured on real data (2026-08-28) to be
              structurally pessimistic, because the dominant background
              component sits at path multiplier alpha ~ 0 and does not depend
              on standoff at all. At the measured sigma of 0.4 mm the true cost
              is 0.37 dB, not the ~20 dB that bound implies. Showing it would
              point every future investigation at the wrong suspect. What
              actually limits live suppression is the BG-applied block below
              (span clamping, 20.6 dB) and per-sweep SNR (5.2 dB). */}
          <div className="grid grid-cols-2 gap-2">
            <InfoTile
              label="σ"
              value={lidarProvenance?.lidar_std != null ? `${lidarProvenance.lidar_std.toFixed(2)} mm` : '—'}
            />
            <InfoTile
              label="n"
              value={lidarProvenance?.lidar_n != null ? String(lidarProvenance.lidar_n) : '—'}
            />
          </div>
          {lidarProvenance?.lidar_n === 0 && (
            <div className="px-2 text-[9px] text-red-400/80 leading-relaxed">
              No lidar readings arrived during that sweep — the standoff is stale.
            </div>
          )}
          <EditableField
            label="Lidar→antenna offset"
            value={lidarOffsetMm}
            unit="mm"
            onChange={(v) => onLidarOffsetChange && onLidarOffsetChange(v)}
            min={-2000}
            max={2000}
            disabled={!onLidarOffsetChange}
          />
          {(lidarProvenance?.roll_deg != null || lidarProvenance?.pitch_deg != null) && (
            <div className="grid grid-cols-2 gap-2">
              <InfoTile label="Roll" value={fmtDeg(lidarProvenance.roll_deg)} />
              <InfoTile label="Pitch" value={fmtDeg(lidarProvenance.pitch_deg)} />
            </div>
          )}
        </div>
      </Section>

      {/* Gains */}
      <Section label="Gains">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="TX1"
            value={tx1Gain}
            unit="dB"
            onChange={(v) => { update('tx1Gain', v); sendParams({ tx1Gain: v }); }}
            min={0}
            max={66}
          />
          <EditableField
            label="RX1"
            value={rx1Gain}
            unit="dB"
            onChange={(v) => { update('rx1Gain', v); sendParams({ rx1Gain: v }); }}
            min={0}
            max={60}
          />
        </div>
      </Section>

      {/* Sweep Info */}
      <Section label="Sweep Info">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Steps" value={numSteps} />
          <InfoTile label="Sweep" value={sweepTime < 1 ? `${(sweepTime * 1000).toFixed(0)} ms` : `${sweepTime.toFixed(1)} s`} />
          <InfoTile label="Δr" value={rangeRes < 1 ? `${(rangeRes * 100).toFixed(1)} cm` : `${rangeRes.toFixed(2)} m`} />
          <InfoTile label="R max" value={maxRange < 1000 ? `${maxRange.toFixed(1)} m` : `${(maxRange / 1000).toFixed(1)} km`} />
        </div>
      </Section>

      {/* Sweep Control */}
      <Section label="Sweep">
        <ToggleButton
          active={sfcwRunning}
          canActivate={canActivate}
          onToggle={() => {
            if (sfcwRunning) { sendSdr({ cmd: 'sfcw_stop' }); return; }
            sendParams();
            sendSdr({ cmd: 'sfcw_start' });
          }}
          activeLabel="Stop Sweep"
          idleLabel="Start Sweep"
          activeSubLabel={`Sweeping ${startFreq}–${stopFreq} MHz`}
          idleSubLabel={!sdrConnected ? 'SDR not connected' : `${numSteps} steps ready`}
          color="orange"
        />
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={onCaptureBg}
            disabled={!sfcwRunning || bgCapturing}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              bgRef
                ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
                : sfcwRunning && !bgCapturing
                  ? 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                  : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            {bgCapturing ? 'Capturing...' : bgRef ? 'BG Ref Active' : 'Capture BG'}
          </button>
          <button
            onClick={onClearBg}
            disabled={!bgRef && !bgModel && !bgCapturing}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              bgRef || bgModel || bgCapturing
                ? 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Clear BG
          </button>
        </div>

        {/* Phase 0.4 -- what the subtraction ACTUALLY did on the last sweep.
            "A model is loaded" and "the model was applied" are different
            statements, and only the second one is visible here. Every path
            that declines to subtract reports its reason instead of warning to
            a console nobody has open. */}
        {bgDiag && !(bgDiag.reason === 'no background selected') && (
          <div className="mt-2 flex flex-col gap-1.5 px-3 py-2 rounded-xl border border-white/8 bg-[#0a0a0a]/60">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">BG applied</span>
              <span className={cn('text-xs font-bold font-mono',
                bgDiag.applied ? (bgDiag.clamped ? 'text-[#f59e0b]' : 'text-emerald-400') : 'text-red-400')}>
                {bgDiag.applied ? (bgDiag.clamped ? 'YES (CLAMPED)' : 'YES') : 'NO'}
                {bgDiag.applied && bgDiag.source ? ` · ${bgDiag.source}` : ''}
              </span>
            </div>
            {!bgDiag.applied && bgDiag.reason && (
              <div className="text-[9px] text-red-400/80 leading-relaxed">{bgDiag.reason}</div>
            )}
            {bgDiag.clamped && (
              <div className="text-[9px] text-[#f59e0b]/80 leading-relaxed">
                Standoff {bgDiag.standoffMm?.toFixed(1)} mm is {bgDiag.clampedBy?.toFixed(1)} mm outside the
                model span {bgDiag.modelSpan?.min?.toFixed(0)}–{bgDiag.modelSpan?.max?.toFixed(0)} mm.
                The model clamps, so it is subtracting a background measured at a different standoff.
              </div>
            )}
            {bgStats?.total > 0 && (
              <div className="flex items-baseline justify-between pt-1 border-t border-white/5">
                <span className="text-[9px] text-white/30">
                  clamped {bgStats.clamped}/{bgStats.total}
                  {' '}({(100 * bgStats.clamped / bgStats.total).toFixed(0)}%)
                  {bgStats.skipped > 0 && ` · skipped ${bgStats.skipped}`}
                </span>
                <button
                  onClick={onResetBgStats}
                  className="text-[9px] text-white/30 hover:text-white/60 underline underline-offset-2"
                >
                  reset
                </button>
              </div>
            )}
          </div>
        )}

        {/* Phase 0.3 -- the loaded model's build-time geometry vs the rig now. */}
        {geoMismatch && (
          <div className={cn('mt-2 px-3 py-2 rounded-xl border text-[9px] leading-relaxed',
            geoMismatch.unknown
              ? 'border-white/10 bg-[#0a0a0a]/60 text-white/35'
              : 'border-[#f59e0b]/30 bg-[#f59e0b]/5 text-[#f59e0b]/90')}>
            {geoMismatch.unknown
              ? 'This model predates geometry stamping — the lidar offset and sweep params it was built under are unknown, so a mismatch cannot be detected.'
              : <>Model was built under different settings: {geoMismatch.fields.join(', ')}. A changed lidar offset shifts every inference by that difference.</>}
          </div>
        )}

        <div className="mt-2 flex flex-col gap-2">
          <button
            onClick={fetchModels}
            className={cn(
              'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              bgModel
                ? 'bg-[#a78bfa]/10 border-[#a78bfa]/30 text-[#a78bfa]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            {bgModel ? `Model: ${bgModel.name || 'loaded'}` : 'Load Model'}
          </button>
          {modelListOpen && modelList && (
            <div className="flex flex-col gap-1 max-h-32 overflow-y-auto rounded-lg border border-white/10 bg-[#0a0a0a] p-2">
              {modelList.length === 0 && (
                <span className="text-[10px] text-white/30 px-1">No models saved</span>
              )}
              {modelList.map((m) => (
                <button
                  key={m.filename}
                  onClick={() => loadModel(m.filename)}
                  className="flex items-baseline justify-between gap-2 text-left px-2 py-1.5 rounded text-[11px] text-white/70 hover:bg-white/10 hover:text-white transition-all"
                >
                  <span className="truncate">{m.name || m.filename}</span>
                  {m.suppressionDb != null ? (
                    <span className={cn('font-mono shrink-0 text-[10px]',
                      m.suppressionDb > 15 ? 'text-green-400/70'
                      : m.suppressionDb > 8 ? 'text-yellow-400/70' : 'text-red-400/70')}>
                      {m.suppressionDb.toFixed(1)} dB
                    </span>
                  ) : (
                    <span className="font-mono shrink-0 text-[10px] text-white/25">legacy</span>
                  )}
                </button>
              ))}
              <button
                onClick={() => setModelListOpen(false)}
                className="text-[10px] text-white/30 hover:text-white/60 mt-1 px-1"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </Section>

      {/* Coherence Diagnostics */}
      <Section label="Coherence Test">
        <button
          onClick={() => {
            setCoherenceRunning(true);
            sendSdr({ cmd: 'sfcw_coherence_test' });
          }}
          disabled={sfcwRunning || coherenceRunning || !canActivate}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all',
            !sfcwRunning && !coherenceRunning && canActivate
              ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
              : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          {coherenceRunning ? `Running (${COHERENCE_SWEEPS} sweeps)...` : 'Run Coherence Test'}
        </button>
        {coherenceResult && (
          <div className="mt-2 space-y-1">
            <div className="grid grid-cols-2 gap-2">
              <InfoTile
                label="Repeatability"
                value={coherenceResult.avg_repeatability?.toFixed(3)}
              />
              <InfoTile
                label="Correlation"
                value={coherenceResult.avg_correlation?.toFixed(3)}
              />
            </div>
            <div className="text-[9px] text-[#555] px-1 space-y-0.5">
              {/* Worst pair first: across ~99 pairs the mean hides a single corrupted
                  sweep, which is exactly what this test is looking for. */}
              <div className="text-[#888]">
                Worst pair — rep {fmtWorst(coherenceResult.repeatability)},
                corr {fmtWorst(coherenceResult.correlation)}
                {coherenceResult.num_sweeps ? ` (${coherenceResult.num_sweeps} sweeps)` : ''}
              </div>
              <div>Repeatability: {fmtList(coherenceResult.repeatability)}</div>
              <div>Correlation: {fmtList(coherenceResult.correlation)}</div>
              <div className="text-[#777] mt-1">1.0 = perfect, {'>'} 0.9 = good</div>
            </div>
          </div>
        )}
      </Section>

      {/* Amplitude scaling — dynamic tracks the sweep, manual pins the range
          profile's Y axis and the waterfall's colour range to fixed limits. */}
      <Section label="Amplitude Scaling">
        <button
          onClick={() => onScaleRangeChange(scaleRange.dynamic
            ? toManualScale()
            : { ...scaleRange, dynamic: true })}
          className={cn(
            'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
            scaleRange.dynamic
              ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
              : 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
          )}
        >
          {scaleRange.dynamic ? '● Dynamic Scaling' : 'Manual Scaling'}
        </button>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <EditableField
            label="Min"
            value={scaleRange.min}
            unit={scaleUnit}
            format={fmtScale}
            disabled={scaleRange.dynamic}
            onChange={(v) => onScaleRangeChange({ ...scaleRange, min: Math.min(v, scaleRange.max - scaleGap) })}
            min={-1e9}
            max={1e9}
          />
          <EditableField
            label="Max"
            value={scaleRange.max}
            unit={scaleUnit}
            format={fmtScale}
            disabled={scaleRange.dynamic}
            onChange={(v) => onScaleRangeChange({ ...scaleRange, max: Math.max(v, scaleRange.min + scaleGap) })}
            min={-1e9}
            max={1e9}
          />
        </div>
        <div className="px-1 mt-1 text-[9px] text-[#555555] leading-relaxed">
          {scaleRange.dynamic
            ? 'Limits track the sweep. Turn off to pin them at their current values.'
            : 'Limits pinned — range profile and waterfall both update live.'}
        </div>
      </Section>

      <Section label="Display Range">
        <button
          onClick={() => onRangeScaleChange(rangeScale && rangeScale.max === 0.5 ? { min: 0, max: bigRangeMax } : { min: 0, max: 0.5 })}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            rangeScale && rangeScale.max === 0.5
              ? 'bg-[#D1855C]/10 border-[#D1855C]/30 text-[#D1855C]'
              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {rangeScale && rangeScale.max === 0.5 ? '● 0 – 0.5 m' : `0 – ${bigRangeMax < 1 ? (bigRangeMax * 100).toFixed(0) + ' cm' : bigRangeMax.toFixed(2) + ' m'}`}
        </button>
      </Section>
    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max, disabled = false, format }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const committedRef = useRef(false);
  const shown = format ? format(value) : value;

  const startEdit = () => {
    setDraft(String(shown));
    setEditing(true);
    committedRef.current = false;
  };

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const num = parseFloat(draft);
    if (!isNaN(num) && num >= min && num <= max) {
      onChange(num);
    }
    setEditing(false);
  };

  return (
    <div
      onClick={!editing && !disabled ? startEdit : undefined}
      className={cn(
        'relative flex flex-col gap-0.5 p-3 rounded-xl border',
        'transition-all duration-300',
        disabled
          ? 'border-white/5 bg-[#0a0a0a]/40 opacity-40 cursor-not-allowed'
          : editing
            ? 'border-[#D1855C]/40 bg-[#D1855C]/5 cursor-text'
            : 'border-white/8 bg-[#0a0a0a]/60 cursor-pointer hover:border-white/20 hover:bg-white/[0.02]',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      {editing ? (
        <div className="flex items-baseline gap-1">
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            className="bg-transparent text-base font-bold font-mono text-white outline-none w-14"
          />
          <span className="text-xs font-semibold text-[#888888]">{unit}</span>
        </div>
      ) : (
        <div className="flex items-baseline gap-1">
          <span className="text-base font-bold font-mono text-white">{shown}</span>
          <span className="text-xs font-semibold text-[#888888]">{unit}</span>
        </div>
      )}
      {editing && (
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#D1855C] to-[#E5A986] rounded-full" />
      )}
    </div>
  );
}
