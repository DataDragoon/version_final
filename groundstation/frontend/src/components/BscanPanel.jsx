import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

export default function BscanPanel({ isConnected, sdrConnected, sendSdr, scanData, scanCapturing, bgCaptured, onScanAction, params, onParamsChange, sfcwParams, svdEnabled, svdK, onSvdEnabledChange, onSvdKChange }) {
  const { stepSize, numPositions, dbFloor, dbCeil, distMin, distMax } = params;

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const canCapture = isConnected && sdrConnected && !scanCapturing;
  const captured = scanData.length;
  const apertureLength = stepSize * (numPositions - 1);

  return (
    <>
      {/* Aperture Parameters */}
      <Section label="Aperture">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Step"
            value={stepSize}
            unit="cm"
            onChange={(v) => update('stepSize', v)}
            min={0.5}
            max={50}
          />
          <EditableField
            label="Positions"
            value={numPositions}
            unit="ct"
            onChange={(v) => update('numPositions', Math.round(v))}
            min={2}
            max={200}
          />
        </div>
      </Section>

      {/* Scan Info */}
      <Section label="Scan Info">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Aperture" value={`${apertureLength.toFixed(1)} cm`} />
          <InfoTile label="Captured" value={`${captured} / ${numPositions}`} />
        </div>
      </Section>

      {/* Background */}
      <Section label="Background">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onScanAction('capture_bg')}
            disabled={!canCapture}
            className={cn(
              'px-3 py-2.5 rounded-lg text-xs font-medium transition-all',
              canCapture
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Capture BG
          </button>
          <button
            onClick={() => onScanAction('clear_bg')}
            className="px-3 py-2.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Clear BG
          </button>
        </div>
        {bgCaptured && (
          <div className="flex items-center gap-2 px-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[10px] text-emerald-400/80 uppercase tracking-wider font-medium">Background active</span>
          </div>
        )}
      </Section>

      {/* Capture */}
      <Section label="Scan">
        <button
          onClick={() => onScanAction('capture')}
          disabled={!canCapture || captured >= numPositions}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            canCapture && captured < numPositions
              ? 'bg-[#6B9BD2]/8 border-[#6B9BD2]/30 hover:border-[#6B9BD2]/50'
              : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            canCapture && captured < numPositions ? 'bg-[#6B9BD2]/15' : 'bg-white/5',
          )}>
            {scanCapturing ? (
              <div className="w-3 h-3 rounded-full border-2 border-[#6B9BD2] border-t-transparent animate-spin" />
            ) : (
              <div className="w-3 h-3 rounded-full border-2 border-current text-[#6B9BD2]" />
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {scanCapturing ? 'Sweeping...' : `Capture Position ${captured + 1}`}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {scanCapturing ? 'Single sweep in progress' :
               captured >= numPositions ? 'Scan complete' :
               `At ${(captured * stepSize).toFixed(1)} cm`}
            </span>
          </div>
        </button>

        {/* Progress bar */}
        {captured > 0 && (
          <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#6B9BD2] to-[#8BB8E8] transition-all duration-300"
              style={{ width: `${(captured / numPositions) * 100}%` }}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onScanAction('new')}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            New Scan
          </button>
          <button
            onClick={() => onScanAction('undo')}
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
      </Section>

      {/* Export / Import */}
      <Section label="Data">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onScanAction('export')}
            disabled={scanData.length === 0}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              scanData.length > 0
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Export
          </button>
          <button
            onClick={() => onScanAction('import')}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Import
          </button>
        </div>
      </Section>

      {/* SVD Filter */}
      <Section label="SVD Filter">
        <button
          onClick={() => onSvdEnabledChange(!svdEnabled)}
          disabled={scanData.length < 2}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            scanData.length < 2
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : svdEnabled
                ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {svdEnabled ? '● SVD ON' : 'SVD OFF'}
        </button>
        <EditableField
          label="k (remove)"
          value={svdK}
          unit=""
          onChange={(v) => onSvdKChange(Math.round(v))}
          min={1}
          max={Math.max(1, scanData.length - 1)}
        />
      </Section>

      {/* Display Controls */}
      <Section label="Display">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="dB Floor"
            value={dbFloor}
            unit="dB"
            onChange={(v) => update('dbFloor', v)}
            min={-120}
            max={40}
          />
          <EditableField
            label="dB Ceil"
            value={dbCeil}
            unit="dB"
            onChange={(v) => update('dbCeil', v)}
            min={-120}
            max={40}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Dist Min"
            value={distMin}
            unit="m"
            onChange={(v) => update('distMin', v)}
            min={0}
            max={20}
          />
          <EditableField
            label="Dist Max"
            value={distMax || (scanData.length > 0 ? scanData[0].distances[scanData[0].distances.length - 1] : 3)}
            unit="m"
            onChange={(v) => update('distMax', v)}
            min={0.01}
            max={20}
          />
        </div>
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
          ? 'border-[#6B9BD2]/40 bg-[#6B9BD2]/5 cursor-text'
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
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#6B9BD2] to-[#8BB8E8] rounded-full" />
      )}
    </div>
  );
}
