import { Activity, Eye, Radio, Radar, ScanLine, ChevronLeft, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import ImuPanel from './ImuPanel';
import OptiFlowPanel from './OptiFlowPanel';
import RfCalibPanel from './RfCalibPanel';
import SfcwPanel from './SfcwPanel';
import BscanPanel from './BscanPanel';

const PANELS = [
  { id: 'imu',       label: 'IMU',       icon: Activity },
  { id: 'optiflow',  label: 'OptiFlow',  icon: Eye },
  { id: 'rfcalib',   label: 'RF Calibrate', icon: Radio },
  { id: 'sfcw',      label: 'SFCW',      icon: Radar },
  { id: 'bscan',     label: 'B-Scan',    icon: ScanLine },
];

export default function Sidebar({
  isConnected,
  activePanel,
  onActivePanelChange,
  piIp,
  onPiIpChange,
  onConnect,
  onDisconnect,
  imuRate,
  imuData,
  lidarMm,
  optiflowRate,
  optiflowData,
  sdrConnected,
  txActive,
  rxActive,
  showFFT,
  onToggleFFT,
  graphPaused,
  onTogglePause,
  sendSdr,
  gyroComp,
  onGyroCompChange,
  sendOptiflow,
  sfcwRunning,
  sfcwStatus,
  sfcwParams,
  onSfcwParamsChange,
  sfcwResult,
  bscanData,
  bscanCapturing,
  bscanBgCaptured,
  bscanParams,
  onBscanParamsChange,
  onBscanAction,
}) {
  return (
    <div className="flex h-screen shrink-0">

      {/* ── Icon rail ─────────────────────────────────────────────── */}
      <div className="relative flex flex-col items-center py-4 gap-1 shrink-0 w-[52px] bg-black border-r border-white/5">

        {/* Logo / connection indicator */}
        <button
          onClick={() => onActivePanelChange(null)}
          className={cn(
            'mb-2 flex items-center justify-center w-10 h-10 rounded-xl transition-all duration-500 cursor-pointer',
            isConnected && 'bg-emerald-500/15',
          )}
        >
          <span className={cn(
            'text-sm font-bold transition-opacity duration-500',
            isConnected ? 'text-emerald-400 opacity-90' : 'text-[#555] opacity-60',
          )}>v0</span>
        </button>

        <div className="w-6 h-px bg-white/5 my-1" />

        {/* Nav icons */}
        {PANELS.map(({ id, label, icon: Icon }) => {
          const isActive = activePanel === id;
          return (
            <button
              key={id}
              onClick={() => onActivePanelChange(activePanel === id ? null : id)}
              title={label}
              className={cn(
                'relative flex items-center justify-center w-10 h-10 rounded-xl',
                'transition-all duration-300 cursor-pointer',
                isActive ? 'bg-[#D1855C]/8' : 'hover:bg-white/4',
              )}
            >
              {isActive && (
                <div className="absolute left-0 w-[2px] h-5 rounded-r-full bg-gradient-to-b from-[#D1855C] to-[#E5A986]" />
              )}
              <Icon
                size={17}
                strokeWidth={isActive ? 2.2 : 1.8}
                className={isActive ? 'text-[#D1855C]' : 'text-[#555555]'}
              />
            </button>
          );
        })}

        <div className="flex-1" />

        {/* Connection toggle */}
        <button
          onClick={isConnected ? onDisconnect : onConnect}
          title={isConnected ? 'Disconnect' : 'Connect'}
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-lg transition-all cursor-pointer',
            isConnected ? 'text-emerald-400 opacity-60 hover:opacity-100' : 'text-[#555] opacity-40 hover:opacity-70',
          )}
        >
          {isConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
        </button>

        {/* Collapse button */}
        {activePanel && (
          <button
            onClick={() => onActivePanelChange(null)}
            title="Collapse"
            className="flex items-center justify-center w-8 h-8 rounded-lg opacity-25 hover:opacity-60 transition-opacity cursor-pointer"
          >
            <ChevronLeft size={14} className="text-[#888888]" />
          </button>
        )}
      </div>

      {/* ── Detail panel ──────────────────────────────────────────── */}
      <div
        className="relative overflow-y-auto overflow-x-hidden bg-[#050505] border-r border-white/5 transition-all duration-300 ease-in-out"
        style={{ width: activePanel ? 276 : 0, opacity: activePanel ? 1 : 0 }}
      >
        {activePanel && (
          <div className="p-5 animate-fadeIn" style={{ minWidth: 276 }}>

            {/* Ambient glow */}
            <div className="absolute top-0 left-0 w-40 h-40 bg-[#D1855C]/5 blur-[70px] rounded-full pointer-events-none" />

            {/* Panel header */}
            <div className="relative flex items-center gap-3 mb-5">
              <div className="w-px h-3.5 bg-gradient-to-b from-[#D1855C] to-[#E5A986] rounded-full" />
              <span className="text-xs font-bold uppercase tracking-widest text-[#888888]">
                {PANELS.find(p => p.id === activePanel)?.label}
              </span>
            </div>

            {/* Connection block */}
            <div className="flex flex-col gap-6">
              <ConnectionBlock
                piIp={piIp}
                onPiIpChange={onPiIpChange}
                onConnect={onConnect}
                isConnected={isConnected}
                imuRate={imuRate}
                optiflowRate={optiflowRate}
                sdrConnected={sdrConnected}
              />

              {/* Panel-specific content */}
              {activePanel === 'imu' && (
                <ImuPanel isConnected={isConnected} imuData={imuData} />
              )}
              {activePanel === 'optiflow' && (
                <OptiFlowPanel
                  isConnected={isConnected}
                  optiflowData={optiflowData}
                  lidarMm={lidarMm}
                  gyroComp={gyroComp}
                  onGyroCompChange={onGyroCompChange}
                  sendOptiflow={sendOptiflow}
                />
              )}
              {activePanel === 'rfcalib' && (
                <RfCalibPanel
                  isConnected={isConnected}
                  sdrConnected={sdrConnected}
                  txActive={txActive}
                  rxActive={rxActive}
                  showFFT={showFFT}
                  onToggleFFT={onToggleFFT}
                  graphPaused={graphPaused}
                  onTogglePause={onTogglePause}
                  sendSdr={sendSdr}
                />
              )}
              {activePanel === 'sfcw' && (
                <SfcwPanel
                  isConnected={isConnected}
                  sdrConnected={sdrConnected}
                  sfcwRunning={sfcwRunning}
                  sfcwStatus={sfcwStatus}
                  sendSdr={sendSdr}
                  params={sfcwParams}
                  onParamsChange={onSfcwParamsChange}
                />
              )}
              {activePanel === 'bscan' && (
                <BscanPanel
                  isConnected={isConnected}
                  sdrConnected={sdrConnected}
                  sendSdr={sendSdr}
                  scanData={bscanData}
                  scanCapturing={bscanCapturing}
                  bgCaptured={bscanBgCaptured}
                  onScanAction={onBscanAction}
                  params={bscanParams}
                  onParamsChange={onBscanParamsChange}
                  sfcwParams={sfcwParams}
                />
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function ConnectionBlock({ piIp, onPiIpChange, onConnect, isConnected, imuRate, optiflowRate, sdrConnected }) {
  return (
    <Section label="Connection">
      <div className="flex flex-col gap-2">
        <div
          className={cn(
            'relative flex items-center gap-2 p-3 rounded-xl border transition-all duration-300',
            isConnected
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : 'border-white/8 bg-[#0a0a0a]/60',
          )}
        >
          <input
            type="text"
            value={piIp}
            onChange={e => onPiIpChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onConnect()}
            placeholder="Pi IP address"
            className="flex-1 bg-transparent text-sm font-mono text-white outline-none placeholder:text-[#333]"
            spellCheck={false}
          />
          {isConnected && (
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="IMU" value={isConnected ? `${imuRate} Hz` : '—'} />
          <InfoTile label="Flow" value={isConnected ? `${optiflowRate} Hz` : '—'} />
          <InfoTile label="SDR" value={sdrConnected ? 'OK' : '—'} />
        </div>
      </div>
    </Section>
  );
}

export function Section({ label, children }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-widest text-[#888888]">{label}</p>
      {children}
    </div>
  );
}

export function InfoTile({ label, value }) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <span className="text-sm font-semibold text-white">{value}</span>
    </div>
  );
}

export function ToggleButton({
  active, canActivate, onToggle,
  activeLabel, idleLabel, activeSubLabel, idleSubLabel,
  color = 'orange',
}) {
  const isOrange = color === 'orange';
  const isCyan = color === 'cyan';
  const accent = isOrange ? '#D1855C' : isCyan ? '#22d3ee' : '#4aff8a';

  return (
    <button
      onClick={onToggle}
      disabled={!canActivate}
      className={cn(
        'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
        'transition-all duration-500 cursor-pointer',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? isOrange
            ? 'bg-[#D1855C]/8 border-[#D1855C]/30 hover:border-[#D1855C]/50'
            : isCyan
              ? 'bg-[#22d3ee]/8 border-[#22d3ee]/30 hover:border-[#22d3ee]/50'
              : 'bg-[#4aff8a]/8 border-[#4aff8a]/30 hover:border-[#4aff8a]/50'
          : canActivate
            ? 'bg-[#0a0a0a]/50 border-white/5 hover:border-white/15 hover:bg-white/[0.03]'
            : 'bg-[#0a0a0a]/50 border-white/5',
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
          active
            ? isOrange ? 'bg-[#D1855C]/15' : isCyan ? 'bg-[#22d3ee]/12' : 'bg-[#4aff8a]/12'
            : canActivate ? 'bg-white/5 group-hover:bg-white/8' : 'bg-white/5',
        )}
      >
        {active
          ? <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: accent }} />
          : <div className="w-0 h-0 border-l-[7px] border-l-current border-y-[5px] border-y-transparent text-[#888] group-hover:text-white transition-colors" />
        }
      </div>

      <div className="flex flex-col gap-0.5 text-left min-w-0">
        <span className="text-sm font-semibold" style={{ color: active ? accent : 'white' }}>
          {active ? activeLabel : idleLabel}
        </span>
        <span className="text-xs text-[#555555] leading-relaxed">{active ? activeSubLabel : idleSubLabel}</span>
      </div>

      {active && (
        <div className="ml-auto shrink-0 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent, boxShadow: `0 0 6px ${accent}cc` }} />
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: accent }}>Live</span>
        </div>
      )}
    </button>
  );
}

export function ErrorBadge({ message }) {
  return (
    <div className="flex items-start gap-2.5 p-3 rounded-xl border border-red-500/20 bg-red-500/5">
      <span className="text-xs text-red-400 leading-relaxed">{message}</span>
    </div>
  );
}
