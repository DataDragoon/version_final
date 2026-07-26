import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

export default function HwCalPanel({ isConnected, sdrConnected, sendSdr, calStatus, onCalAction, fmcwTestRunning, fmcwTestProgress }) {
  const canCapture = isConnected && sdrConnected;

  const perPos = calStatus.perPosition || { positions: [], stepSize: 5, numPositions: 20 };
  const captured = perPos.positions.length;

  return (
    <>
      {/* Calibration Scans */}
      <Section label="Calibration Scans">

        {/* Card 1: Cable Thru */}
        <CalCard
          title="Cable Thru"
          instructions="Connect TX1 → RX1 with SMA cable. No antennas. TX: 20 dB, RX: 20 dB."
          status={calStatus.cableThru}
          capturing={calStatus._capturing === 'cable_thru'}
          canCapture={canCapture}
          onCapture={() => onCalAction('capture_cable_thru')}
        />

        {/* Card 2: Free Space Isolation */}
        <CalCard
          title="Free Space Isolation"
          instructions="Mount antennas normally. Point at open sky — no reflectors within 5m."
          status={calStatus.freeSpace}
          capturing={calStatus._capturing === 'free_space'}
          canCapture={canCapture}
          onCapture={() => onCalAction('capture_free_space')}
        />

        {/* Card 3: Per-Position Isolation */}
        <div className="flex flex-col gap-2 p-3 rounded-xl border border-white/5 bg-[#0a0a0a]/40">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-white">Per-Position Isolation</span>
            {captured >= perPos.numPositions && (
              <div className="flex items-center gap-1.5 ml-auto">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-[10px] text-emerald-400/80 font-medium">Complete</span>
              </div>
            )}
          </div>

          {/* Instruction box */}
          <div className="border-l-2 border-[#A78BFA]/30 pl-2.5 py-1 bg-white/[0.02] rounded-r-lg">
            <span className="text-[10px] text-[#777777] leading-relaxed">
              Same free-space setup. Step antenna along rail, capture at each position.
            </span>
          </div>

          {/* Parameters */}
          <div className="grid grid-cols-2 gap-2">
            <EditableField
              label="Step"
              value={perPos.stepSize}
              unit="cm"
              onChange={(v) => onCalAction('per_position_set_step', { stepSize: v })}
              min={0.5}
              max={50}
            />
            <EditableField
              label="Positions"
              value={perPos.numPositions}
              unit="ct"
              onChange={(v) => onCalAction('per_position_set_num', { numPositions: Math.round(v) })}
              min={2}
              max={200}
            />
          </div>

          {/* Capture button */}
          <button
            onClick={() => onCalAction('capture_per_position')}
            disabled={!canCapture || captured >= perPos.numPositions || calStatus._capturing === 'per_position'}
            className={cn(
              'group relative flex items-center gap-3 w-full p-3 rounded-xl border',
              'transition-all duration-500 cursor-pointer',
              'disabled:cursor-not-allowed disabled:opacity-40',
              canCapture && captured < perPos.numPositions
                ? 'bg-[#A78BFA]/8 border-[#A78BFA]/30 hover:border-[#A78BFA]/50'
                : 'bg-[#0a0a0a]/50 border-white/5',
            )}
          >
            <div className={cn(
              'flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-all duration-500',
              canCapture && captured < perPos.numPositions ? 'bg-[#A78BFA]/15' : 'bg-white/5',
            )}>
              {calStatus._capturing === 'per_position' ? (
                <div className="w-2.5 h-2.5 rounded-full border-2 border-[#A78BFA] border-t-transparent animate-spin" />
              ) : (
                <div className="w-2.5 h-2.5 rounded-full border-2 border-current text-[#A78BFA]" />
              )}
            </div>
            <div className="flex flex-col gap-0.5 text-left min-w-0">
              <span className="text-xs font-semibold text-white">
                {calStatus._capturing === 'per_position' ? 'Sweeping...' : `Capture Position ${captured + 1}`}
              </span>
              <span className="text-[10px] text-[#555555]">
                {calStatus._capturing === 'per_position' ? 'Sweep in progress' :
                 captured >= perPos.numPositions ? 'Scan complete' :
                 `At ${(captured * perPos.stepSize).toFixed(1)} cm`}
              </span>
            </div>
          </button>

          {/* Progress bar */}
          {captured > 0 && (
            <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#A78BFA] to-[#C4B5FD] transition-all duration-300"
                style={{ width: `${(captured / perPos.numPositions) * 100}%` }}
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#555555] font-medium">
              {captured} / {perPos.numPositions} captured
            </span>
          </div>

          {/* New / Undo buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onCalAction('per_position_new')}
              className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
            >
              New Scan
            </button>
            <button
              onClick={() => onCalAction('per_position_undo')}
              disabled={captured === 0}
              className={cn(
                'px-3 py-2 rounded-lg text-xs font-medium transition-all',
                captured > 0
                  ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                  : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
              )}
            >
              Undo Last
            </button>
          </div>
        </div>
      </Section>

      {/* Stored Calibrations */}
      <Section label="Stored Calibrations">
        <div className="flex flex-col gap-2">
          <StoredItem label="Cable Thru" status={calStatus.cableThru} />
          <StoredItem label="Free Space" status={calStatus.freeSpace} />
          <StoredItem
            label="Per-Position"
            status={captured > 0 ? { count: captured } : null}
            extra={captured > 0 ? `${captured} positions` : null}
          />
        </div>
        <button
          onClick={() => onCalAction('refresh_status')}
          disabled={!canCapture}
          className={cn(
            'px-3 py-2.5 rounded-lg text-xs font-medium transition-all w-full',
            canCapture
              ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
              : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          Refresh
        </button>
      </Section>

      {/* Chirp Validation Tests */}
      <Section label="Chirp Validation">
        <div className="border-l-2 border-[#A78BFA]/30 pl-2.5 py-1 bg-white/[0.02] rounded-r-lg mb-2">
          <span className="text-[10px] text-[#777777] leading-relaxed">
            Requires cable-through setup (TX1 → cable → RX1, TX2 → cable → RX2). Tests validate chirp de-chirp and reference division quality.
          </span>
        </div>

        <FmcwTestCard
          title="Chirp Linearity"
          description="Measures residual phase after de-chirp on cable reference. Deviation from linear = filter distortion."
          metric="< 5° RMS = pass"
          canRun={canCapture && !fmcwTestRunning}
          running={fmcwTestRunning}
          onRun={() => onCalAction('fmcw_test', { test_type: 'linearity' })}
        />

        <FmcwTestCard
          title="Stitching Quality"
          description="Phase jumps at sub-band boundaries before/after correction. Checks for ghost peaks (PSLR)."
          metric="< 3° RMS jump, PSLR < -20 dB = pass"
          canRun={canCapture && !fmcwTestRunning}
          running={fmcwTestRunning}
          onRun={() => onCalAction('fmcw_test', { test_type: 'stitching' })}
        />

        <FmcwTestCard
          title="Repeatability"
          description="Back-to-back sweeps — measures correlation and residual difference. Low repeatability = stitching not correcting properly."
          metric="Correlation > 0.99, residual < -40 dB = pass"
          canRun={canCapture && !fmcwTestRunning}
          running={fmcwTestRunning}
          onRun={() => onCalAction('fmcw_test', { test_type: 'repeatability' })}
        />

        <FmcwTestCard
          title="Phase Residual"
          description="Full-bandwidth phase linearity on cable. The most direct measure of synthetic bandwidth quality."
          metric="< 5° RMS residual = pass"
          canRun={canCapture && !fmcwTestRunning}
          running={fmcwTestRunning}
          onRun={() => onCalAction('fmcw_test', { test_type: 'phase_residual' })}
        />

        <FmcwTestCard
          title="Channel Calibration"
          description="Captures differential analog filter response between RX1 and RX2. Stored and applied to all future sweeps to remove systematic channel mismatch."
          metric="Captures & saves calibration"
          canRun={canCapture && !fmcwTestRunning}
          running={fmcwTestRunning}
          onRun={() => onCalAction('fmcw_test', { test_type: 'channel_cal' })}
        />

        <FmcwTestCard
          title="Parametric Sweep"
          description="Runs linearity test across multiple PLL settle times, discard buffers, and averages to find optimal config."
          metric="Reports best configuration"
          canRun={canCapture && !fmcwTestRunning}
          running={fmcwTestRunning}
          onRun={() => onCalAction('fmcw_test', { test_type: 'parametric_linearity' })}
        />

        {/* Progress indicator during chirp test */}
        {fmcwTestRunning && (
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-[#A78BFA]/30 bg-[#A78BFA]/5">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full border-2 border-[#A78BFA] border-t-transparent animate-spin" />
              <span className="text-xs font-medium text-white/80">
                {fmcwTestProgress
                  ? `Sub-band ${fmcwTestProgress.step + 1}/${fmcwTestProgress.total}` + (fmcwTestProgress.freq_mhz ? ` — ${fmcwTestProgress.freq_mhz} MHz` : '')
                  : 'Configuring hardware...'}
              </span>
            </div>
            {fmcwTestProgress && fmcwTestProgress.step != null && fmcwTestProgress.total != null && (
              <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#A78BFA] to-[#C4B5FD] transition-all duration-300"
                  style={{ width: `${(fmcwTestProgress.step / fmcwTestProgress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

function CalCard({ title, instructions, status, capturing, canCapture, onCapture }) {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl border border-white/5 bg-[#0a0a0a]/40">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-white">{title}</span>
        {status && (
          <div className="flex items-center gap-1.5 ml-auto">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[10px] text-emerald-400/80 font-medium">Captured</span>
          </div>
        )}
      </div>

      {/* Instruction box */}
      <div className="border-l-2 border-[#A78BFA]/30 pl-2.5 py-1 bg-white/[0.02] rounded-r-lg">
        <span className="text-[10px] text-[#777777] leading-relaxed">{instructions}</span>
      </div>

      {/* Capture button */}
      <button
        onClick={onCapture}
        disabled={!canCapture || capturing}
        className={cn(
          'group relative flex items-center gap-3 w-full p-3 rounded-xl border',
          'transition-all duration-500 cursor-pointer',
          'disabled:cursor-not-allowed disabled:opacity-40',
          canCapture
            ? 'bg-[#A78BFA]/8 border-[#A78BFA]/30 hover:border-[#A78BFA]/50'
            : 'bg-[#0a0a0a]/50 border-white/5',
        )}
      >
        <div className={cn(
          'flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-all duration-500',
          canCapture ? 'bg-[#A78BFA]/15' : 'bg-white/5',
        )}>
          {capturing ? (
            <div className="w-2.5 h-2.5 rounded-full border-2 border-[#A78BFA] border-t-transparent animate-spin" />
          ) : (
            <div className="w-2.5 h-2.5 rounded-full border-2 border-current text-[#A78BFA]" />
          )}
        </div>
        <div className="flex flex-col gap-0.5 text-left min-w-0">
          <span className="text-xs font-semibold text-white">
            {capturing ? 'Sweeping...' : 'Capture'}
          </span>
          <span className="text-[10px] text-[#555555]">
            {capturing ? 'Sweep in progress' : status ? 'Recapture to overwrite' : 'Single sweep'}
          </span>
        </div>
      </button>

      {/* Timestamp */}
      {status && status.timestamp && (
        <span className="text-[9px] text-[#444444] px-1">
          Last: {new Date(status.timestamp).toLocaleString()}
        </span>
      )}
    </div>
  );
}

function FmcwTestCard({ title, description, metric, canRun, running, onRun }) {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl border border-white/5 bg-[#0a0a0a]/40 mb-2">
      <span className="text-xs font-semibold text-white">{title}</span>
      <span className="text-[10px] text-[#777777] leading-relaxed">{description}</span>
      <span className="text-[9px] text-[#A78BFA]/70 font-mono">{metric}</span>
      <button
        onClick={onRun}
        disabled={!canRun}
        className={cn(
          'group relative flex items-center gap-3 w-full p-2.5 rounded-xl border',
          'transition-all duration-500 cursor-pointer',
          'disabled:cursor-not-allowed disabled:opacity-40',
          canRun
            ? 'bg-[#A78BFA]/8 border-[#A78BFA]/30 hover:border-[#A78BFA]/50'
            : 'bg-[#0a0a0a]/50 border-white/5',
        )}
      >
        <div className={cn(
          'flex items-center justify-center w-6 h-6 rounded-lg shrink-0 transition-all duration-500',
          canRun ? 'bg-[#A78BFA]/15' : 'bg-white/5',
        )}>
          {running ? (
            <div className="w-2.5 h-2.5 rounded-full border-2 border-[#A78BFA] border-t-transparent animate-spin" />
          ) : (
            <div className="w-2 h-2 rounded-full border-2 border-current text-[#A78BFA]" />
          )}
        </div>
        <span className="text-xs font-medium text-white/70">{running ? 'Running...' : 'Run Test'}</span>
      </button>
    </div>
  );
}

function StoredItem({ label, status, extra }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#0a0a0a]/50 border border-white/5">
      <div className={cn(
        'w-2 h-2 rounded-full',
        status ? 'bg-emerald-400' : 'bg-[#333333]',
      )} />
      <span className="text-xs text-white/70 flex-1">{label}</span>
      <span className="text-[10px] text-[#555555] font-mono">
        {status ? (extra || 'OK') : '---'}
      </span>
    </div>
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
          ? 'border-[#A78BFA]/40 bg-[#A78BFA]/5 cursor-text'
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
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#A78BFA] to-[#C4B5FD] rounded-full" />
      )}
    </div>
  );
}
