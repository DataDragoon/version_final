import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function SarPanel({ bscanData, sarParams, onSarParamsChange, sarResult, sarProgress }) {
  const {
    pixelsX, pixelsZ, depthMin, depthMax, lateralMin, lateralMax,
    dbFloor, dbCeil, meanSubtract, svdEnabled, svdK, window: windowType,
    wallEnabled, wallStandoff, wallThickness, wallPermittivity,
  } = sarParams;

  const update = (key, value) => {
    onSarParamsChange({ ...sarParams, [key]: value });
  };

  const numPositions = bscanData ? bscanData.length : 0;

  return (
    <>
      {/* Status */}
      <Section label="Status">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Positions" value={numPositions < 2 ? `${numPositions} (need ≥2)` : numPositions} />
          {sarResult && <InfoTile label="Time" value={`${sarResult.computeTimeMs} ms`} />}
        </div>
        {sarResult && (
          <div className="grid grid-cols-2 gap-2">
            <InfoTile label="Grid" value={`${sarResult.pixelsX}×${sarResult.pixelsZ}`} />
            <InfoTile label="Mode" value={sarResult.coherent ? 'coherent' : 'incoherent'} />
          </div>
        )}
        {sarProgress !== null && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Reconstructing...</span>
              <span className="text-[10px] font-mono text-white/60">{Math.round(sarProgress * 100)}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-[width] duration-100"
                style={{ width: `${sarProgress * 100}%` }}
              />
            </div>
          </div>
        )}
      </Section>

      {/* Clutter Removal */}
      <Section label="Clutter Removal">
        <button
          onClick={() => update('svdEnabled', !svdEnabled)}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            svdEnabled
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {svdEnabled ? `● SVD Filter ON (k=${svdK})` : 'SVD Filter OFF'}
        </button>
        {svdEnabled && (
          <div className="grid grid-cols-1 gap-2">
            <EditableField
              label="SVD k"
              value={svdK}
              unit="components"
              onChange={(v) => update('svdK', Math.round(v))}
              min={1}
              max={10}
            />
          </div>
        )}
        {!svdEnabled && (
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
        )}
      </Section>

      {/* Window */}
      <Section label="Window">
        <div className="flex gap-2">
          <button
            onClick={() => update('window', 'blackman-harris')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              windowType === 'blackman-harris'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Blackman-Harris
          </button>
          <button
            onClick={() => update('window', 'hanning')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              windowType === 'hanning'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Hanning
          </button>
        </div>
      </Section>

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

      {/* Wall */}
      <Section label="Wall">
        <button
          onClick={() => update('wallEnabled', !wallEnabled)}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            wallEnabled
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {wallEnabled ? '● Wall Model ON' : 'Wall Model OFF'}
        </button>
        {wallEnabled && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="Standoff"
                value={wallStandoff}
                unit="cm"
                onChange={(v) => update('wallStandoff', v)}
                min={0}
                max={100}
              />
              <EditableField
                label="Thickness"
                value={wallThickness}
                unit="cm"
                onChange={(v) => update('wallThickness', v)}
                min={1}
                max={100}
              />
            </div>
            <div className="grid grid-cols-1 gap-2">
              <EditableField
                label="Permittivity εr"
                value={wallPermittivity}
                unit=""
                onChange={(v) => update('wallPermittivity', v)}
                min={1}
                max={20}
              />
            </div>
            <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
              Depth axis corrected: air → wall (εr={wallPermittivity}) → behind-wall.
            </div>
          </>
        )}
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
