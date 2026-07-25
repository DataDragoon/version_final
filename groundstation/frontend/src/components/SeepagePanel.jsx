import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function SeepagePanel({
  isConnected, sdrConnected, scanData, scanCapturing, onScanAction,
  params, onParamsChange, progress, hasReference,
}) {
  const { stepSize, wallThickness, rangeOffset, dbFloor, dbCeil, subDbFloor, subDbCeil, slopeMin, slopeMax, deconvolve } = params;

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const canCapture = isConnected && sdrConnected && !scanCapturing;
  const captured = scanData ? scanData.length : 0;

  return (
    <>
      {/* Wall Parameters */}
      <Section label="Wall">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Thickness"
            value={wallThickness}
            unit="cm"
            onChange={(v) => update('wallThickness', v)}
            min={1}
            max={100}
          />
          <EditableField
            label="Offset"
            value={rangeOffset}
            unit="cm"
            onChange={(v) => update('rangeOffset', v)}
            min={0}
            max={200}
          />
        </div>
        <div className="grid grid-cols-1 gap-2">
          <EditableField
            label="Step"
            value={stepSize}
            unit="cm"
            onChange={(v) => update('stepSize', v)}
            min={0.5}
            max={50}
          />
        </div>
      </Section>

      {/* Reference */}
      <Section label="Reference">
        {hasReference ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 p-3 rounded-xl border border-sky-500/30 bg-sky-500/5">
              <div className="w-1.5 h-1.5 rounded-full bg-sky-400" />
              <span className="text-xs text-sky-400 font-medium">Reference captured</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onScanAction('capture_ref')}
                disabled={!canCapture}
                className="px-2 py-2 rounded-lg text-[10px] font-medium bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Recapture
              </button>
              <button
                onClick={() => onScanAction('clear_ref')}
                className="px-2 py-2 rounded-lg text-[10px] font-medium bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => onScanAction('capture_ref')}
            disabled={!canCapture}
            className={cn(
              'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
              canCapture
                ? 'bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20'
                : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            {scanCapturing ? 'Capturing...' : 'Capture Reference (clean wall)'}
          </button>
        )}
        <p className="text-[10px] text-white/30 leading-relaxed">
          Capture one position on a defect-free section. Aligned subtraction reveals hidden anomalies.
        </p>
      </Section>

      {/* Deconvolve */}
      <Section label="Processing">
        <button
          onClick={() => update('deconvolve', !deconvolve)}
          className={cn(
            'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
            deconvolve
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'bg-white/5 border-white/10 text-white/50 hover:text-white hover:bg-white/10'
          )}
        >
          {deconvolve ? 'Surface Deconvolution ON' : 'Surface Deconvolution OFF'}
        </button>
        <p className="text-[10px] text-white/30 leading-relaxed">
          Normalizes coupling variations by dividing each position's spectrum by its surface echo.
        </p>
      </Section>

      {/* Scan */}
      <Section label="Scan">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Captured" value={captured} />
          <InfoTile label="Aperture" value={`${(Math.max(0, captured - 1) * stepSize).toFixed(0)} cm`} />
        </div>
        <button
          onClick={() => onScanAction('capture')}
          disabled={!canCapture}
          className={cn(
            'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
            canCapture
              ? 'bg-blue-500/10 border-blue-500/30 text-blue-400 hover:bg-blue-500/20'
              : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          {scanCapturing ? 'Capturing...' : 'Capture Position'}
        </button>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => onScanAction('new')}
            className="px-2 py-2 rounded-lg text-[10px] font-medium bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
          >
            New
          </button>
          <button
            onClick={() => onScanAction('undo')}
            disabled={captured === 0}
            className="px-2 py-2 rounded-lg text-[10px] font-medium bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Undo
          </button>
          <button
            onClick={() => onScanAction('import')}
            className="px-2 py-2 rounded-lg text-[10px] font-medium bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
          >
            Import
          </button>
        </div>
        <button
          onClick={() => onScanAction('export')}
          disabled={captured === 0}
          className="w-full px-3 py-2 rounded-lg text-[10px] font-medium bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Export Scan
        </button>
      </Section>

      {/* Display Range */}
      <Section label="Raw Range">
        <div className="grid grid-cols-2 gap-2">
          <EditableField label="dB Floor" value={dbFloor} unit="dB" onChange={(v) => update('dbFloor', v)} min={-120} max={80} />
          <EditableField label="dB Ceil" value={dbCeil} unit="dB" onChange={(v) => update('dbCeil', v)} min={-120} max={80} />
        </div>
      </Section>

      {hasReference && (
        <Section label="Sub Range">
          <div className="grid grid-cols-2 gap-2">
            <EditableField label="dB Floor" value={subDbFloor} unit="dB" onChange={(v) => update('subDbFloor', v)} min={-120} max={80} />
            <EditableField label="dB Ceil" value={subDbCeil} unit="dB" onChange={(v) => update('subDbCeil', v)} min={-120} max={80} />
          </div>
        </Section>
      )}

      <Section label="Slope Range">
        <div className="grid grid-cols-2 gap-2">
          <EditableField label="Slope Min" value={slopeMin} unit="dB" onChange={(v) => update('slopeMin', v)} min={-30} max={30} />
          <EditableField label="Slope Max" value={slopeMax} unit="dB" onChange={(v) => update('slopeMax', v)} min={-30} max={30} />
        </div>
      </Section>

      {/* Progress */}
      {progress !== null && (
        <Section label="Processing">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-blue-400 font-medium">Computing...</span>
              <span className="text-[10px] font-mono text-white/60">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-[width] duration-100" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        </Section>
      )}
    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => { setDraft(String(value)); setEditing(true); };
  const commit = () => {
    const num = parseFloat(draft);
    if (!isNaN(num) && num >= min && num <= max) onChange(num);
    setEditing(false);
  };

  return (
    <div
      onClick={!editing ? startEdit : undefined}
      className={cn(
        'relative flex flex-col gap-0.5 p-3 rounded-xl border transition-all duration-300',
        editing
          ? 'border-blue-500/40 bg-blue-500/5 cursor-text'
          : 'border-white/8 bg-[#0a0a0a]/60 cursor-pointer hover:border-white/20 hover:bg-white/[0.02]',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      {editing ? (
        <div className="flex items-baseline gap-1">
          <input
            autoFocus type="text" value={draft}
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
      {editing && <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-blue-500 to-blue-300 rounded-full" />}
    </div>
  );
}
