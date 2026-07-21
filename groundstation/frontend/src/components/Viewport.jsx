import { cn } from '@/lib/utils';
import { Activity, Eye, Radio, Radar, ScanLine, Wrench, Zap } from 'lucide-react';
import ImuDisplay from './ImuDisplay';
import OptiFlowDisplay from './OptiFlowDisplay';
import WaveformDisplay from './WaveformDisplay';
import ReceiverDisplay from './ReceiverDisplay';
import FftDisplay from './FftDisplay';
import SfcwDisplay from './SfcwDisplay';
import BscanDisplay from './BscanDisplay';
import HwCalDisplay from './HwCalDisplay';

export default function Viewport({
  activePanel,
  isConnected,
  piIp,
  imuData,
  optiflowData,
  txActive,
  rxActive,
  rxSamples,
  fftData,
  showFFT,
  graphPaused,
  sfcwResult,
  sfcwProgress,
  sfcwRunning,
  bscanData,
  bscanParams,
  bscanCapturing,
  sfcwParams,
  hwCalResult,
  hwCalMode,
}) {
  if (!activePanel) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-black select-none">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-[#D1855C]/[0.03] blur-[120px] rounded-full" />
        </div>
        <h1 className="text-[56px] font-bold tracking-[0.25em] uppercase mb-4">
          <span className="text-primary">ver</span><span className="text-white/80">sion0</span>
        </h1>
        <p className="text-[16px] font-medium tracking-[0.4em] uppercase text-white/30">
          Groundstation
        </p>
      </div>
    );
  }

  if (activePanel === 'imu') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Activity} label="IMU Orientation" active={isConnected && !!imuData} color="orange" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {isConnected && imuData && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/5 blur-[80px] rounded-full" />
              </div>
            )}
            <ImuDisplay imuData={imuData} />
            {!imuData && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No IMU data</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'optiflow') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Eye} label="OptiFlow" active={isConnected && !!optiflowData} color="green" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {isConnected && optiflowData && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#4aff8a]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <OptiFlowDisplay piIp={piIp} optiflowData={optiflowData} isConnected={isConnected} />
            {!optiflowData && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No stream</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'rfcalib') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">

        {/* Upper: TX Waveform */}
        <div className="relative flex flex-col min-h-0 border-b border-white/5" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Zap} label="Transmitter" active={txActive} color="orange" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {txActive && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/5 blur-[80px] rounded-full" />
              </div>
            )}
            <WaveformDisplay active={txActive} />
          </div>
        </div>

        {/* Lower: Receiver */}
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Radio} label="Receiver" active={rxActive} color="cyan" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {rxActive && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#22d3ee]/4 blur-[80px] rounded-full" />
              </div>
            )}
            {showFFT ? (
              <FftDisplay active={rxActive} fftData={fftData} paused={graphPaused} />
            ) : (
              <ReceiverDisplay active={rxActive} samples={rxSamples} paused={graphPaused} />
            )}
            {!rxActive && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No signal</span>
              </div>
            )}
          </div>
        </div>

      </div>
    );
  }

  if (activePanel === 'sfcw') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Radar} label="SFCW Radar" active={sfcwRunning || !!sfcwResult} color="orange" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {(sfcwRunning || sfcwResult) && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <SfcwDisplay
              sfcwResult={sfcwResult}
              sfcwProgress={sfcwProgress}
              sfcwRunning={sfcwRunning}
              dbFloor={sfcwParams.dbFloor}
              dbCeil={sfcwParams.dbCeil}
            />
            {!sfcwResult && !sfcwRunning && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No sweep data</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'bscan') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={ScanLine} label="B-Scan Imaging" active={bscanData.length > 0} color="cyan" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {bscanData.length > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#6B9BD2]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <BscanDisplay
              scanData={bscanData}
              params={bscanParams}
              capturing={bscanCapturing}
              sfcwProgress={sfcwProgress}
              dbFloor={sfcwParams.dbFloor}
              dbCeil={sfcwParams.dbCeil}
            />
            {bscanData.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No scan data</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'hwcal') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Wrench} label="HW Calibration" active={!!hwCalResult} color="violet" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {hwCalResult && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#A78BFA]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <HwCalDisplay calResult={hwCalResult} calMode={hwCalMode} />
            {!hwCalResult && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No calibration data</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function PaneHeader({ icon: Icon, label, active, color }) {
  const colorMap = {
    orange: { accent: '#D1855C', to: '#E5A986' },
    cyan:   { accent: '#22d3ee', to: '#67e8f9' },
    green:  { accent: '#4aff8a', to: '#86efac' },
    violet: { accent: '#A78BFA', to: '#C4B5FD' },
  };
  const { accent, to } = colorMap[color] || colorMap.orange;

  return (
    <div className="relative flex items-center gap-2.5 px-5 py-2 border-b border-white/5 bg-[#050505]/80 backdrop-blur-sm shrink-0">
      <div
        className="w-px h-3 rounded-full transition-all duration-500"
        style={active
          ? { background: `linear-gradient(to bottom, ${accent}, ${to})` }
          : { background: '#333333' }
        }
      />
      <Icon
        size={13}
        strokeWidth={2}
        className="transition-colors duration-500"
        style={{ color: active ? accent : '#555555' }}
      />
      <span
        className="text-xs font-bold uppercase tracking-widest transition-colors duration-500"
        style={{ color: active ? accent : '#666666' }}
      >
        {label}
      </span>
      {active && (
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: `${accent}b3` }}>
            Active
          </span>
        </div>
      )}
    </div>
  );
}
