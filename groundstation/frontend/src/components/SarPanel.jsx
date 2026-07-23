import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function SarPanel({ bscanData, bscanParams, sarParams, onSarParamsChange, onSarAction, sarResult }) {
  const { pixelsX, pixelsZ, depthMin, depthMax, lateralMin, lateralMax, dbFloor, dbCeil, meanSubtract } = sarParams;

  const update = (key, value) => {
    onSarParamsChange({ ...sarParams, [key]: value });
  };

  const hasBscan = bscanData && bscanData.length >= 2;

  return (
    <>
      {/* Image Grid */}
      <Section label="Image Grid">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Lateral px"
            value={pixelsX}
            unit="px"
            onChange={(v) => update('pixelsX', Math.round(v))}
            min={20}
            max={500}
          />
          <EditableField
            label="Depth px"
            value={pixelsZ}
            unit="px"
            onChange={(v) => update('pixelsZ', Math.round(v))}
            min={20}
            max={500}
          />
        </div>
      </Section>

      {/* Region of Interest */}
      <Section label="Region">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Depth Min"
            value={depthMin}
            unit="m"
            onChange={(v) => update('depthMin', v)}
            min={0}
            max={10}
          />
          <EditableField
            label="Depth Max"
            value={depthMax}
            unit="m"
            onChange={(v) => update('depthMax', v)}
            min={0.01}
            max={10}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Lat Min"
            value={lateralMin}
            unit="m"
            onChange={(v) => update('lateralMin', v)}
            min={-5}
            max={5}
          />
          <EditableField
            label="Lat Max"
            value={lateralMax}
            unit="m"
            onChange={(v) => update('lateralMax', v)}
            min={-5}
            max={5}
          />
        </div>
      </Section>

      {/* Processing */}
      <Section label="Processing">
        <button
          onClick={() => update('meanSubtract', !meanSubtract)}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            meanSubtract
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {meanSubtract ? '● Mean Subtraction ON' : 'Mean Subtraction OFF'}
        </button>
      </Section>

      {/* Display */}
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
      </Section>

      {/* Reconstruct */}
      <Section label="Reconstruct">
        <button
          onClick={() => onSarAction('reconstruct')}
          disabled={!hasBscan}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            hasBscan
              ? 'bg-emerald-500/8 border-emerald-500/30 hover:border-emerald-500/50'
              : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            hasBscan ? 'bg-emerald-500/15' : 'bg-white/5',
          )}>
            <div className="w-3 h-3 rounded-sm border-2 border-current text-emerald-400" />
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              Run SAR
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {!hasBscan ? 'Need B-scan data (≥2 positions)' :
               `Backproject ${bscanData.length} positions → ${pixelsX}×${pixelsZ} image`}
            </span>
          </div>
        </button>

        {sarResult && (
          <div className="grid grid-cols-2 gap-2 mt-1">
            <InfoTile label="Time" value={`${sarResult.computeTimeMs} ms`} />
            <InfoTile label="Size" value={`${sarResult.pixelsX}×${sarResult.pixelsZ}`} />
          </div>
        )}
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
          ? 'border-emerald-500/40 bg-emerald-500/5 cursor-text'
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
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-emerald-500 to-emerald-300 rounded-full" />
      )}
    </div>
  );
}
