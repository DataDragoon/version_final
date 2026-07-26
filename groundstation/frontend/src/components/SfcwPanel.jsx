import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

const BUFFER_SAMPLES = 1024;
const SAMPLE_RATE = 2_000_000;
const BUFFER_TIME_MS = (BUFFER_SAMPLES / SAMPLE_RATE) * 1000;
const CHIRP_SAMPLES = 2000;
const CHIRP_SAMPLE_RATE = 20_000_000;
const CHIRP_BUFFER_TIME_MS = (CHIRP_SAMPLES / CHIRP_SAMPLE_RATE) * 1000;

export default function SfcwPanel({ isConnected, sdrConnected, sfcwRunning, sfcwStatus, sendSdr, params, onParamsChange, sweepMode, fmcwParams, onFmcwParamsChange }) {
  const { startFreq, stopFreq, stepSize, settleTime, numBuffers, tx1Gain, rx1Gain, rangeOffset, dbFloor, dbCeil } = params;

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const updateFmcw = (key, value) => {
    onFmcwParamsChange({ ...fmcwParams, [key]: value });
  };

  const canActivate = isConnected && sdrConnected;
  const isFmcw = sweepMode === 'fmcw';
  const isRunning = isFmcw ? sfcwStatus?.fmcw_running : sfcwRunning;

  const sendParams = (overrides = {}) => {
    sendSdr({
      cmd: 'sfcw_set_params',
      start_freq_mhz: overrides.startFreq ?? startFreq,
      stop_freq_mhz: overrides.stopFreq ?? stopFreq,
      step_size_mhz: overrides.stepSize ?? stepSize,
      settle_time_ms: overrides.settleTime ?? settleTime,
      num_buffers: overrides.numBuffers ?? numBuffers,
      tx1_gain: overrides.tx1Gain ?? tx1Gain,
      rx1_gain: overrides.rx1Gain ?? rx1Gain,
      range_offset: overrides.rangeOffset ?? rangeOffset,
    });
  };

  const sendFmcwParams = (overrides = {}) => {
    sendSdr({
      cmd: 'fmcw_set_params',
      start_freq_mhz: overrides.startFreq ?? fmcwParams.startFreq,
      stop_freq_mhz: overrides.stopFreq ?? fmcwParams.stopFreq,
      step_size_mhz: overrides.stepSize ?? fmcwParams.stepSize,
      pll_settle_time_ms: overrides.pllSettleTime ?? fmcwParams.pllSettleTime,
      num_buffers: overrides.numBuffers ?? fmcwParams.numBuffers,
      tx1_gain: overrides.tx1Gain ?? fmcwParams.tx1Gain,
      rx1_gain: overrides.rx1Gain ?? fmcwParams.rx1Gain,
      range_offset: overrides.rangeOffset ?? fmcwParams.rangeOffset,
    });
  };

  // SFCW computed values
  const numSteps = Math.floor((stopFreq - startFreq) / stepSize) + 1;
  const bandwidth = (stopFreq - startFreq) * 1e6;
  const rangeRes = bandwidth > 0 ? (299792458 / (2 * bandwidth)) : Infinity;
  const maxRange = stepSize > 0 ? (299792458 / (2 * stepSize * 1e6)) : Infinity;
  const captureTimeMs = numBuffers * BUFFER_TIME_MS;
  const sweepTime = numSteps * (settleTime + captureTimeMs) / 1000;

  // Stepped-Chirp computed values
  const fmcwStepSize = fmcwParams?.stepSize || 10;
  const fmcwBandwidth = ((fmcwParams?.stopFreq || 5000) - (fmcwParams?.startFreq || 1000)) * 1e6;
  const fmcwRangeRes = fmcwBandwidth > 0 ? (299792458 / (2 * fmcwBandwidth)) : Infinity;
  const fmcwNumSteps = Math.floor(fmcwBandwidth / (fmcwStepSize * 1e6)) + 1;
  const fmcwSettleMs = fmcwParams?.pllSettleTime || 1;
  const fmcwNumBufs = fmcwParams?.numBuffers || 2;
  const fmcwCaptureMs = fmcwNumBufs * CHIRP_BUFFER_TIME_MS;
  const fmcwSweepTime = fmcwNumSteps * (fmcwSettleMs + fmcwCaptureMs) / 1000;
  const fmcwMaxRange = fmcwStepSize > 0 ? (299792458 / (2 * fmcwStepSize * 1e6)) : Infinity;

  return (
    <>
      {/* Mode Toggle */}
      <Section label="Sweep Mode">
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => sendSdr({ cmd: 'set_sweep_mode', mode: 'sfcw' })}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              !isFmcw
                ? 'bg-[#D1855C]/15 border-[#D1855C]/40 text-[#D1855C]'
                : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70'
            )}
          >
            SFCW
          </button>
          <button
            onClick={() => sendSdr({ cmd: 'set_sweep_mode', mode: 'fmcw' })}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              isFmcw
                ? 'bg-[#D1855C]/15 border-[#D1855C]/40 text-[#D1855C]'
                : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70'
            )}
          >
            Chirp
          </button>
        </div>
      </Section>

      {!isFmcw ? (
        <>
          {/* SFCW Parameters */}
          <Section label="Sweep Range">
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="Start"
                value={startFreq}
                unit="MHz"
                onChange={(v) => { update('startFreq', v); sendParams({ startFreq: v }); }}
                min={47}
                max={6000}
              />
              <EditableField
                label="Stop"
                value={stopFreq}
                unit="MHz"
                onChange={(v) => { update('stopFreq', v); sendParams({ stopFreq: v }); }}
                min={47}
                max={6000}
              />
            </div>
          </Section>

          <Section label="Step Config">
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="Step Size"
                value={stepSize}
                unit="MHz"
                onChange={(v) => { update('stepSize', v); sendParams({ stepSize: v }); }}
                min={0.1}
                max={500}
              />
              <EditableField
                label="Settle"
                value={settleTime}
                unit="ms"
                onChange={(v) => { update('settleTime', v); sendParams({ settleTime: v }); }}
                min={0.1}
                max={50}
              />
            </div>
            <div className="flex flex-col gap-1">
              <EditableField
                label="Buffers"
                value={numBuffers}
                unit="x1024 smp"
                onChange={(v) => { update('numBuffers', v); sendParams({ numBuffers: v }); }}
                min={1}
                max={64}
              />
              <span className="text-[9px] text-[#333333] leading-tight px-1">
                {captureTimeMs.toFixed(2)} ms capture per step ({(numBuffers * BUFFER_SAMPLES).toLocaleString()} samples)
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
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="dB Floor"
                value={dbFloor}
                unit="dB"
                onChange={(v) => { update('dbFloor', v); }}
                min={-120}
                max={40}
              />
              <EditableField
                label="dB Ceil"
                value={dbCeil}
                unit="dB"
                onChange={(v) => { update('dbCeil', v); }}
                min={-120}
                max={40}
              />
            </div>
          </Section>

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

          <Section label="Sweep Info">
            <div className="grid grid-cols-2 gap-2">
              <InfoTile label="Steps" value={numSteps} />
              <InfoTile label="Sweep" value={sweepTime < 1 ? `${(sweepTime * 1000).toFixed(0)} ms` : `${sweepTime.toFixed(1)} s`} />
              <InfoTile label="Δr" value={rangeRes < 1 ? `${(rangeRes * 100).toFixed(1)} cm` : `${rangeRes.toFixed(2)} m`} />
              <InfoTile label="R max" value={maxRange < 1000 ? `${maxRange.toFixed(1)} m` : `${(maxRange / 1000).toFixed(1)} km`} />
            </div>
          </Section>
        </>
      ) : (
        <>
          {/* Stepped-Chirp Parameters */}
          <Section label="Sweep Range">
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="Start"
                value={fmcwParams?.startFreq ?? 1000}
                unit="MHz"
                onChange={(v) => { updateFmcw('startFreq', v); sendFmcwParams({ startFreq: v }); }}
                min={47}
                max={6000}
              />
              <EditableField
                label="Stop"
                value={fmcwParams?.stopFreq ?? 5000}
                unit="MHz"
                onChange={(v) => { updateFmcw('stopFreq', v); sendFmcwParams({ stopFreq: v }); }}
                min={47}
                max={6000}
              />
            </div>
          </Section>

          <Section label="Step Config">
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="Step Size"
                value={fmcwParams?.stepSize ?? 10}
                unit="MHz"
                onChange={(v) => { updateFmcw('stepSize', v); sendFmcwParams({ stepSize: v }); }}
                min={0.1}
                max={500}
              />
              <EditableField
                label="Settle"
                value={fmcwParams?.pllSettleTime ?? 1}
                unit="ms"
                onChange={(v) => { updateFmcw('pllSettleTime', v); sendFmcwParams({ pllSettleTime: v }); }}
                min={0.1}
                max={20}
              />
            </div>
            <div className="flex flex-col gap-1">
              <EditableField
                label="Buffers"
                value={fmcwParams?.numBuffers ?? 2}
                unit="x1024 smp"
                onChange={(v) => { updateFmcw('numBuffers', v); sendFmcwParams({ numBuffers: v }); }}
                min={1}
                max={64}
              />
              <span className="text-[9px] text-[#333333] leading-tight px-1">
                {fmcwCaptureMs.toFixed(2)} ms capture per step ({(fmcwNumBufs * CHIRP_SAMPLES).toLocaleString()} samples @ 20 MSPS)
              </span>
            </div>
            <EditableField
              label="Range Offset"
              value={fmcwParams?.rangeOffset ?? 0.55}
              unit="m"
              onChange={(v) => { updateFmcw('rangeOffset', v); sendFmcwParams({ rangeOffset: v }); }}
              min={0}
              max={10}
            />
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="dB Floor"
                value={fmcwParams?.dbFloor ?? -90}
                unit="dB"
                onChange={(v) => { updateFmcw('dbFloor', v); }}
                min={-120}
                max={40}
              />
              <EditableField
                label="dB Ceil"
                value={fmcwParams?.dbCeil ?? -20}
                unit="dB"
                onChange={(v) => { updateFmcw('dbCeil', v); }}
                min={-120}
                max={40}
              />
            </div>
          </Section>

          <Section label="Gains">
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="TX1"
                value={fmcwParams?.tx1Gain ?? 30}
                unit="dB"
                onChange={(v) => { updateFmcw('tx1Gain', v); sendFmcwParams({ tx1Gain: v }); }}
                min={0}
                max={66}
              />
              <EditableField
                label="RX1"
                value={fmcwParams?.rx1Gain ?? 30}
                unit="dB"
                onChange={(v) => { updateFmcw('rx1Gain', v); sendFmcwParams({ rx1Gain: v }); }}
                min={0}
                max={60}
              />
            </div>
          </Section>

          <Section label="Sweep Info">
            <div className="grid grid-cols-2 gap-2">
              <InfoTile label="Steps" value={fmcwNumSteps} />
              <InfoTile label="Sweep" value={fmcwSweepTime < 1 ? `${(fmcwSweepTime * 1000).toFixed(0)} ms` : `${fmcwSweepTime.toFixed(1)} s`} />
              <InfoTile label="Δr" value={fmcwRangeRes < 1 ? `${(fmcwRangeRes * 100).toFixed(1)} cm` : `${fmcwRangeRes.toFixed(2)} m`} />
              <InfoTile label="R max" value={fmcwMaxRange < 1000 ? `${fmcwMaxRange.toFixed(1)} m` : `${(fmcwMaxRange / 1000).toFixed(1)} km`} />
            </div>
          </Section>
        </>
      )}

      {/* Sweep Control (shared) */}
      <Section label="Sweep">
        <ToggleButton
          active={isRunning}
          canActivate={canActivate}
          onToggle={() => {
            if (isFmcw) {
              sendSdr({ cmd: isRunning ? 'fmcw_stop' : 'fmcw_start' });
            } else {
              sendSdr({ cmd: isRunning ? 'sfcw_stop' : 'sfcw_start' });
            }
          }}
          activeLabel="Stop Sweep"
          idleLabel="Start Sweep"
          activeSubLabel={`${isFmcw ? 'Chirp' : 'SFCW'} sweeping ${isFmcw ? (fmcwParams?.startFreq ?? 1000) : startFreq}–${isFmcw ? (fmcwParams?.stopFreq ?? 6000) : stopFreq} MHz`}
          idleSubLabel={!sdrConnected ? 'SDR not connected' : `${isFmcw ? fmcwNumSteps : numSteps} steps ready`}
          color="orange"
        />
        <div className="flex items-center justify-between px-1 mt-2 mb-1">
          <span className="text-[10px] text-[#888] uppercase tracking-wider">
            {sfcwStatus?.sub_mode === 'background' ? '● Background active' :
             sfcwStatus?.sub_mode === 'reference' ? '● Reference active (aligned)' :
             'No subtraction'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => sendSdr({ cmd: isFmcw ? 'fmcw_capture_bg' : 'sfcw_capture_bg' })}
            disabled={!isRunning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              !isRunning
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : sfcwStatus?.sub_mode === 'background'
                  ? 'bg-[#D1855C]/10 border-[#D1855C]/30 text-[#D1855C]'
                  : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Capture BG
          </button>
          <button
            onClick={() => sendSdr({ cmd: isFmcw ? 'fmcw_capture_ref' : 'sfcw_capture_ref' })}
            disabled={!isRunning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              !isRunning
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : sfcwStatus?.sub_mode === 'reference'
                  ? 'bg-[#D1855C]/10 border-[#D1855C]/30 text-[#D1855C]'
                  : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Capture Ref
          </button>
        </div>
        <button
          onClick={() => sendSdr({ cmd: isFmcw ? 'fmcw_clear_all' : 'sfcw_clear_all' })}
          disabled={!sfcwStatus?.sub_mode}
          className={cn(
            'w-full mt-1 px-3 py-2 rounded-lg text-xs font-medium transition-all',
            sfcwStatus?.sub_mode
              ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
              : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          Clear
        </button>
      </Section>
    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
    setDraft(String(value));
    setEditing(true);
  };

  const commit = () => {
    const num = parseFloat(draft);
    if (!isNaN(num) && num >= min && num <= max) {
      onChange(num);
    }
    setEditing(false);
  };

  return (
    <div
      onClick={!editing ? startEdit : undefined}
      className={cn(
        'relative flex flex-col gap-0.5 p-3 rounded-xl border',
        'transition-all duration-300',
        editing
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
          <span className="text-base font-bold font-mono text-white">{value}</span>
          <span className="text-xs font-semibold text-[#888888]">{unit}</span>
        </div>
      )}
      {editing && (
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#D1855C] to-[#E5A986] rounded-full" />
      )}
    </div>
  );
}
