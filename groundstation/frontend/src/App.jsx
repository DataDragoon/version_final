import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Viewport from './components/Viewport';
import { runBackprojection } from './lib/sar';

export default function App() {
  const [activePanel, setActivePanel] = useState(null);
  const [piIp, setPiIp] = useState(() => localStorage.getItem('pi_ip') || '');

  // IMU state
  const [imuData, setImuData] = useState(null);
  const [imuRate, setImuRate] = useState(0);
  const imuCountRef = useRef(0);
  const [lidarMm, setLidarMm] = useState(null);

  // OptiFlow state
  const [optiflowData, setOptiflowData] = useState(null);
  const [optiflowRate, setOptiflowRate] = useState(0);
  const optiflowCountRef = useRef(0);
  const [gyroComp, setGyroComp] = useState(false);

  // SDR / RF Calib state
  const [sdrStatus, setSdrStatus] = useState(null);
  const [rxSamples, setRxSamples] = useState([]);
  const [fftData, setFftData] = useState(null);
  const [txActive, setTxActive] = useState(false);
  const [rxActive, setRxActive] = useState(false);
  const [showFFT, setShowFFT] = useState(true);
  const [graphPaused, setGraphPaused] = useState(false);

  // SFCW state
  const [sfcwRunning, setSfcwRunning] = useState(false);
  const [sfcwStatus, setSfcwStatus] = useState(null);
  const [sfcwResult, setSfcwResult] = useState(null);
  const [sfcwProgress, setSfcwProgress] = useState(null);

  // SFCW panel params (lifted so they survive panel switches)
  const [sfcwParams, setSfcwParams] = useState({
    startFreq: 1000,
    stopFreq: 6000,
    stepSize: 10,
    settleTime: 3,
    numBuffers: 4,
    tx1Gain: 30,
    rx1Gain: 30,
    rangeOffset: 0.55,
    dbFloor: -90,
    dbCeil: -20,
  });

  // B-Scan state
  const [bscanData, setBscanData] = useState([]);
  const [bscanCapturing, setBscanCapturing] = useState(false);
  const [bscanBgCaptured, setBscanBgCaptured] = useState(false);
  const bscanPendingRef = useRef(null); // 'capture' | 'capture_bg' | null
  const [bscanParams, setBscanParams] = useState({
    stepSize: 5,
    numPositions: 20,
    dbFloor: -90,
    dbCeil: -20,
    distMin: 0,
    distMax: null,  // null = auto (full range)
  });

  // SAR state
  const [sarParams, setSarParams] = useState({
    pixelsX: 100,
    pixelsZ: 100,
    depthMin: 0.1,
    depthMax: 3.0,
    lateralMin: undefined,
    lateralMax: undefined,
    meanSubtract: true,
    dbFloor: -60,
    dbCeil: -10,
  });
  const [sarResult, setSarResult] = useState(null);

  // HW Calibration state
  const [hwCalStatus, setHwCalStatus] = useState({
    cableThru: null,
    freeSpace: null,
    perPosition: { positions: [], stepSize: 5, numPositions: 20 },
    _capturing: null, // 'cable_thru' | 'free_space' | 'per_position' | null
  });
  const [hwCalResult, setHwCalResult] = useState(null);
  const [hwCalMode, setHwCalMode] = useState(null);
  const hwCalPendingRef = useRef(null);

  // IMU WebSocket
  const handleImuMessage = useCallback((msg) => {
    imuCountRef.current++;
    setImuData(msg);
    if (msg.lidar !== null && msg.lidar !== undefined) {
      setLidarMm(msg.lidar);
    }
  }, []);

  const imuUrl = piIp ? `ws://${piIp}:9001` : null;
  const { status: imuStatus, connect: connectImu, disconnect: disconnectImu } = useWebSocket(imuUrl, handleImuMessage);

  // OptiFlow WebSocket
  const handleOptiflowMessage = useCallback((msg) => {
    optiflowCountRef.current++;
    setOptiflowData(msg);
  }, []);

  const optiflowUrl = piIp ? `ws://${piIp}:9002` : null;
  const { status: optiflowStatus, send: sendOptiflow, connect: connectOptiflow, disconnect: disconnectOptiflow } = useWebSocket(optiflowUrl, handleOptiflowMessage);

  // SDR WebSocket (RF Calib + SFCW share this connection)
  const handleSdrMessage = useCallback((msg) => {
    if (msg.type === 'status') {
      setSdrStatus(msg);
      setTxActive(msg.tx_active);
      setRxActive(msg.rx_active);
      if (!msg.rx_active) {
        setRxSamples([]);
        setFftData(null);
      }
    } else if (msg.type === 'rx_data') {
      setRxSamples(msg.i);
    } else if (msg.type === 'rx_fft') {
      setFftData({ magnitudes: msg.magnitudes, freq_span: msg.freq_span || 2000000 });
    } else if (msg.type === 'sfcw_status') {
      setSfcwRunning(msg.running);
      setSfcwStatus(msg);
      if (msg.background_active !== undefined) {
        setBscanBgCaptured(msg.background_active);
      }
    } else if (msg.type === 'sfcw_result') {
      if (bscanPendingRef.current === 'capture') {
        const posData = { magnitudes: [...msg.magnitudes], distances: [...msg.distances] };
        if (msg.h_cal_real && msg.h_cal_imag) {
          posData.h_cal_real = [...msg.h_cal_real];
          posData.h_cal_imag = [...msg.h_cal_imag];
          posData.freqs = [...msg.freqs];
        }
        setBscanData(prev => [...prev, posData]);
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      } else if (bscanPendingRef.current === 'capture_bg') {
        setBscanBgCaptured(true);
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      } else {
        setSfcwResult(msg);
      }
      setSfcwProgress(null);
    } else if (msg.type === 'sfcw_progress') {
      setSfcwProgress(msg);
    } else if (msg.type === 'sfcw_error') {
      setSfcwRunning(false);
      setSfcwProgress(null);
      if (bscanPendingRef.current) {
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      }
    } else if (msg.type === 'hwcal_result') {
      const mode = msg.mode; // 'cable_thru' | 'free_space' | 'per_position'
      setHwCalMode(mode);
      if (mode === 'per_position') {
        setHwCalStatus(prev => ({
          ...prev,
          _capturing: null,
          perPosition: {
            ...prev.perPosition,
            positions: [...prev.perPosition.positions, msg.magnitudes_db],
          },
        }));
        setHwCalResult(prev => ({
          frequencies: msg.frequencies,
          traces: [...(prev && prev.traces ? prev.traces : []), msg.magnitudes_db],
        }));
      } else {
        const key = mode === 'cable_thru' ? 'cableThru' : 'freeSpace';
        setHwCalStatus(prev => ({
          ...prev,
          _capturing: null,
          [key]: { timestamp: msg.timestamp || Date.now() },
        }));
        setHwCalResult({ frequencies: msg.frequencies, magnitudes_db: msg.magnitudes_db });
      }
    } else if (msg.type === 'hwcal_status') {
      setHwCalStatus(prev => ({
        ...prev,
        _capturing: prev._capturing,
        cableThru: msg.cable_thru,
        freeSpace: msg.free_space,
        perPosition: {
          ...prev.perPosition,
          positions: msg.per_position ? new Array(msg.per_position.count).fill(null) : prev.perPosition.positions,
          stepSize: msg.per_position?.step_size || prev.perPosition.stepSize,
        },
      }));
    }
  }, []);

  const sdrUrl = piIp ? `ws://${piIp}:9003` : null;
  const { status: sdrConnectionStatus, send: sendSdr, connect: connectSdr, disconnect: disconnectSdr } = useWebSocket(sdrUrl, handleSdrMessage);

  const handleBscanAction = useCallback((action) => {
    if (action === 'capture') {
      bscanPendingRef.current = 'capture';
      setBscanCapturing(true);
      sendSdr({ cmd: 'bscan_capture' });
    } else if (action === 'capture_bg') {
      bscanPendingRef.current = 'capture_bg';
      setBscanCapturing(true);
      sendSdr({ cmd: 'bscan_capture_bg' });
    } else if (action === 'clear_bg') {
      sendSdr({ cmd: 'bscan_clear_bg' });
      setBscanBgCaptured(false);
    } else if (action === 'new') {
      setBscanData([]);
    } else if (action === 'undo') {
      setBscanData(prev => prev.slice(0, -1));
    } else if (action === 'export') {
      const exportData = {
        version: 1,
        timestamp: new Date().toISOString(),
        params: bscanParams,
        sfcwParams: sfcwParams,
        data: bscanData,
      };
      const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bscan_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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
              if (imported.params) {
                setBscanParams(prev => ({ ...prev, ...imported.params }));
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
  }, [sendSdr, bscanData, bscanParams, sfcwParams]);

  const handleHwCalAction = useCallback((action, params) => {
    if (action === 'capture_cable_thru') {
      setHwCalStatus(prev => ({ ...prev, _capturing: 'cable_thru' }));
      sendSdr({ cmd: 'hwcal_capture', mode: 'cable_thru' });
    } else if (action === 'capture_free_space') {
      setHwCalStatus(prev => ({ ...prev, _capturing: 'free_space' }));
      sendSdr({ cmd: 'hwcal_capture', mode: 'free_space' });
    } else if (action === 'capture_per_position') {
      setHwCalStatus(prev => ({ ...prev, _capturing: 'per_position' }));
      sendSdr({ cmd: 'hwcal_capture', mode: 'per_position' });
    } else if (action === 'per_position_new') {
      setHwCalStatus(prev => ({
        ...prev,
        perPosition: { ...prev.perPosition, positions: [] },
      }));
      setHwCalResult(null);
      setHwCalMode(null);
      sendSdr({ cmd: 'hwcal_per_position_new' });
    } else if (action === 'per_position_undo') {
      setHwCalStatus(prev => ({
        ...prev,
        perPosition: { ...prev.perPosition, positions: prev.perPosition.positions.slice(0, -1) },
      }));
      setHwCalResult(prev => prev && prev.traces ? { ...prev, traces: prev.traces.slice(0, -1) } : prev);
      sendSdr({ cmd: 'hwcal_per_position_undo' });
    } else if (action === 'refresh_status') {
      sendSdr({ cmd: 'hwcal_get_status' });
    } else if (action === 'per_position_set_step') {
      setHwCalStatus(prev => ({
        ...prev,
        perPosition: { ...prev.perPosition, stepSize: params.stepSize },
      }));
    } else if (action === 'per_position_set_num') {
      setHwCalStatus(prev => ({
        ...prev,
        perPosition: { ...prev.perPosition, numPositions: params.numPositions },
      }));
    }
  }, [sendSdr]);

  const handleSarAction = useCallback((action) => {
    if (action === 'reconstruct') {
      if (bscanData.length < 2) return;
      const result = runBackprojection(bscanData, bscanParams, sarParams);
      setSarResult(result);
    }
  }, [bscanData, bscanParams, sarParams]);

  // Rate counter interval
  const rateIntervalRef = useRef(null);

  const handleConnect = useCallback(() => {
    if (!piIp.trim()) return;
    localStorage.setItem('pi_ip', piIp);
    connectImu();
    connectOptiflow();
    connectSdr();

    if (rateIntervalRef.current) clearInterval(rateIntervalRef.current);
    rateIntervalRef.current = setInterval(() => {
      setImuRate(imuCountRef.current);
      imuCountRef.current = 0;
      setOptiflowRate(optiflowCountRef.current);
      optiflowCountRef.current = 0;
    }, 1000);
  }, [piIp, connectImu, connectOptiflow, connectSdr]);

  const handleDisconnect = useCallback(() => {
    disconnectImu();
    disconnectOptiflow();
    disconnectSdr();
    if (rateIntervalRef.current) { clearInterval(rateIntervalRef.current); rateIntervalRef.current = null; }
    setImuRate(0);
    setOptiflowRate(0);
  }, [disconnectImu, disconnectOptiflow, disconnectSdr]);

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
        optiflowRate={optiflowRate}
        optiflowData={optiflowData}
        sdrConnected={sdrConnectionStatus === 'connected'}
        txActive={txActive}
        rxActive={rxActive}
        showFFT={showFFT}
        onToggleFFT={setShowFFT}
        graphPaused={graphPaused}
        onTogglePause={setGraphPaused}
        sendSdr={sendSdr}
        gyroComp={gyroComp}
        onGyroCompChange={(v) => {
          setGyroComp(v);
          sendOptiflow({ cmd: 'gyro_comp', enabled: v });
        }}
        sendOptiflow={sendOptiflow}
        sfcwRunning={sfcwRunning}
        sfcwStatus={sfcwStatus}
        sfcwParams={sfcwParams}
        onSfcwParamsChange={setSfcwParams}
        sfcwResult={sfcwResult}
        bscanData={bscanData}
        bscanCapturing={bscanCapturing}
        bscanBgCaptured={bscanBgCaptured}
        bscanParams={bscanParams}
        onBscanParamsChange={setBscanParams}
        onBscanAction={handleBscanAction}
        hwCalStatus={hwCalStatus}
        onHwCalAction={handleHwCalAction}
        bscanDataForSar={bscanData}
        sarParams={sarParams}
        onSarParamsChange={setSarParams}
        onSarAction={handleSarAction}
        sarResult={sarResult}
      />
      <Viewport
        activePanel={activePanel}
        isConnected={isConnected}
        piIp={piIp}
        imuData={imuData}
        optiflowData={optiflowData}
        txActive={txActive}
        rxActive={rxActive}
        rxSamples={rxSamples}
        fftData={fftData}
        showFFT={showFFT}
        graphPaused={graphPaused}
        sfcwResult={sfcwResult}
        sfcwProgress={sfcwProgress}
        sfcwRunning={sfcwRunning}
        bscanData={bscanData}
        bscanParams={bscanParams}
        bscanCapturing={bscanCapturing}
        sfcwParams={sfcwParams}
        hwCalResult={hwCalResult}
        hwCalMode={hwCalMode}
        sarResult={sarResult}
        sarParams={sarParams}
      />
    </div>
  );
}
