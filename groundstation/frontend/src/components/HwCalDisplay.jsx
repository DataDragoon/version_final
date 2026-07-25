import { useRef, useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';
const TRACE_COLOR = '#A78BFA';
const TRACE_COLOR_ALT = '#C4B5FD';

export default function HwCalDisplay({ calResult, calMode }) {
  // FMCW test results use a separate component (no canvas needed)
  const isFmcwTest = calMode === 'fmcw_test' && calResult && calResult.type === 'fmcw_test_result';

  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const latestResult = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  useEffect(() => {
    if (calResult && !isFmcwTest) {
      latestResult.current = calResult;
    }
  }, [calResult, isFmcwTest]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const result = latestResult.current;
    if (!result || !result.frequencies || result.frequencies.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No calibration data', w / 2, h / 2);
      return;
    }

    const freqs = result.frequencies;
    const isMultiTrace = calMode === 'per_position' && result.traces && result.traces.length > 0;
    const traces = isMultiTrace ? result.traces : [result.magnitudes_db];
    const n = freqs.length;

    const pad = { top: 32, bottom: 44, left: 56, right: 20 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Determine Y range from data
    let yMin = Infinity, yMax = -Infinity;
    for (const trace of traces) {
      if (!trace) continue;
      for (let i = 0; i < trace.length; i++) {
        if (trace[i] < yMin) yMin = trace[i];
        if (trace[i] > yMax) yMax = trace[i];
      }
    }
    // Add some padding
    const yRange = yMax - yMin || 1;
    yMin -= yRange * 0.05;
    yMax += yRange * 0.05;

    // Frequency range (convert to GHz for display)
    const fMin = freqs[0];
    const fMax = freqs[freqs.length - 1];

    // Grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    const yTicks = 6;
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      const val = yMax - (i / yTicks) * (yMax - yMin);
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${val.toFixed(0)} dB`, pad.left - 6, y + 3);
    }

    const xTicks = 8;
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      const freq = fMin + (i / xTicks) * (fMax - fMin);
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      // Display in GHz if > 1000 MHz
      if (fMax > 1000) {
        ctx.fillText(`${(freq / 1000).toFixed(2)}`, x, h - pad.bottom + 14);
      } else {
        ctx.fillText(`${freq.toFixed(0)}`, x, h - pad.bottom + 14);
      }
    }

    // X-axis unit label
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(fMax > 1000 ? 'GHz' : 'MHz', w - pad.right + 10, h - pad.bottom + 14);

    // Draw traces
    for (let t = 0; t < traces.length; t++) {
      const trace = traces[t];
      if (!trace) continue;

      const alpha = isMultiTrace ? Math.max(0.15, 0.6 / Math.sqrt(traces.length)) : 1.0;
      const color = isMultiTrace
        ? `rgba(167, 139, 250, ${alpha})`
        : TRACE_COLOR;

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = isMultiTrace ? 1.0 : 1.5;

      for (let i = 0; i < n; i++) {
        const x = pad.left + (i / (n - 1)) * plotW;
        const y = pad.top + ((yMax - trace[i]) / (yMax - yMin)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // If multi-trace, draw mean trace on top
    if (isMultiTrace && traces.length > 1) {
      const mean = new Array(n).fill(0);
      for (const trace of traces) {
        for (let i = 0; i < n; i++) {
          mean[i] += trace[i] / traces.length;
        }
      }
      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < n; i++) {
        const x = pad.left + (i / (n - 1)) * plotW;
        const y = pad.top + ((yMax - mean[i]) / (yMax - yMin)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Crosshair
    if (crosshair && traces.length > 0) {
      const { x: mx } = crosshair;
      const relX = (mx - pad.left) / plotW;
      if (relX >= 0 && relX <= 1) {
        const idx = Math.round(relX * (n - 1));
        const cx = pad.left + (idx / (n - 1)) * plotW;
        const mainTrace = isMultiTrace ? traces[0] : traces[0];
        const cy = pad.top + ((yMax - mainTrace[idx]) / (yMax - yMin)) * plotH;

        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffffff44';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, pad.top);
        ctx.lineTo(cx, h - pad.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        const freqVal = freqs[idx];
        const magVal = mainTrace[idx];
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        const freqStr = fMax > 1000 ? `${(freqVal / 1000).toFixed(3)} GHz` : `${freqVal.toFixed(1)} MHz`;
        ctx.fillText(`${freqStr}  ${magVal.toFixed(1)} dB`, cx + 8, cy - 4);
      }
    }

    // Title
    ctx.fillStyle = '#A78BFA';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    const titleMap = {
      cable_thru: 'CABLE THRU — H(f)',
      free_space: 'FREE SPACE ISOLATION — H(f)',
      per_position: `PER-POSITION ISOLATION — ${traces.length} traces`,
    };
    ctx.fillText(titleMap[calMode] || 'CALIBRATION', pad.left, 18);

    // Info
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${n} points, ${(fMin / 1000).toFixed(2)}–${(fMax / 1000).toFixed(2)} GHz`, w - pad.right, 18);

    if (isMultiTrace && traces.length > 1) {
      ctx.fillStyle = '#ffffff88';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('white = mean', w - pad.right, 30);
    }
  }, [crosshair, calMode]);

  useEffect(() => {
    const render = () => {
      draw();
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw]);

  const handleMouseMove = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const handleMouseLeave = () => setCrosshair(null);

  if (isFmcwTest) {
    return <FmcwTestDisplay result={calResult} />;
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    </div>
  );
}

function FmcwTestDisplay({ result }) {
  const testNames = {
    linearity: 'Chirp Linearity',
    stitching: 'Stitching Quality',
    repeatability: 'Sweep Repeatability',
    phase_residual: 'Phase Residual',
  };

  const passed = result.pass;

  return (
    <div className="flex flex-col w-full h-full p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className={cn(
          'w-3 h-3 rounded-full',
          passed ? 'bg-emerald-400' : 'bg-red-400'
        )} />
        <h2 className="text-sm font-bold text-white">
          {testNames[result.test] || result.test}
        </h2>
        <span className={cn(
          'ml-auto px-2 py-1 rounded text-xs font-bold',
          passed ? 'bg-emerald-400/15 text-emerald-400' : 'bg-red-400/15 text-red-400'
        )}>
          {passed ? 'PASS' : 'FAIL'}
        </span>
      </div>

      {/* Description */}
      <p className="text-[11px] text-[#777] mb-4 leading-relaxed">{result.description}</p>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {result.test === 'linearity' && (
          <>
            <MetricTile label="RMS Phase Error" value={`${result.overall_rms_deg?.toFixed(2)}°`} pass={result.overall_rms_deg < 5} />
            <MetricTile label="Peak Phase Error" value={`${result.overall_peak_deg?.toFixed(2)}°`} />
            <MetricTile label="Threshold" value="< 5° RMS" />
            <MetricTile label="Sub-bands" value={result.per_sub_band?.length || '—'} />
          </>
        )}
        {result.test === 'stitching' && (
          <>
            <MetricTile label="RMS Jump Before" value={`${result.rms_jump_before_deg?.toFixed(2)}°`} />
            <MetricTile label="RMS Jump After" value={`${result.rms_jump_after_deg?.toFixed(2)}°`} pass={result.rms_jump_after_deg < 3} />
            <MetricTile label="PSLR" value={`${result.pslr_db?.toFixed(1)} dB`} pass={result.pslr_db < -20} />
            <MetricTile label="Main Lobe Width" value={`${result.main_lobe_width_bins} bins`} />
          </>
        )}
        {result.test === 'repeatability' && (
          <>
            <MetricTile label="Correlation" value={result.correlation?.toFixed(5)} pass={result.correlation > 0.99} />
            <MetricTile label="Residual" value={`${result.residual_db?.toFixed(1)} dB`} pass={result.residual_db < -40} />
            <MetricTile label="Threshold (corr)" value="> 0.99" />
            <MetricTile label="Threshold (res)" value="< -40 dB" />
          </>
        )}
        {result.test === 'phase_residual' && (
          <>
            <MetricTile label="RMS Residual" value={`${result.rms_residual_deg?.toFixed(2)}°`} pass={result.rms_residual_deg < 5} />
            <MetricTile label="Peak Residual" value={`${result.peak_residual_deg?.toFixed(2)}°`} />
            <MetricTile label="Cable Delay" value={`${result.estimated_cable_delay_ns?.toFixed(2)} ns`} />
            <MetricTile label="Threshold" value="< 5° RMS" />
          </>
        )}
      </div>

      {/* Per sub-band details for linearity test */}
      {result.test === 'linearity' && result.per_sub_band && (
        <div className="flex flex-col gap-1 mt-2">
          <span className="text-[10px] text-[#555] uppercase tracking-wider mb-1">Per Sub-band</span>
          <div className="max-h-40 overflow-y-auto rounded border border-white/5">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="text-[#555]">
                  <th className="text-left p-1">#</th>
                  <th className="text-right p-1">RMS°</th>
                  <th className="text-right p-1">Peak°</th>
                  <th className="text-right p-1">Beat Hz</th>
                </tr>
              </thead>
              <tbody>
                {result.per_sub_band.map((sb, i) => (
                  <tr key={i} className={cn('border-t border-white/5', sb.rms_phase_err_deg > 5 ? 'text-red-400/70' : 'text-white/60')}>
                    <td className="p-1">{i}</td>
                    <td className="text-right p-1">{sb.rms_phase_err_deg.toFixed(2)}</td>
                    <td className="text-right p-1">{sb.peak_phase_err_deg.toFixed(2)}</td>
                    <td className="text-right p-1">{sb.beat_freq_hz.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stitching range profile plot */}
      {result.test === 'stitching' && result.range_profile_db && (
        <div className="mt-2">
          <span className="text-[10px] text-[#555] uppercase tracking-wider mb-1 block">Range Profile (normalized)</span>
          <FmcwMiniPlot data={result.range_profile_db} yLabel="dB" color="#A78BFA" />
        </div>
      )}

      {/* Phase residual plot */}
      {result.test === 'phase_residual' && result.residual_plot && (
        <div className="mt-2">
          <span className="text-[10px] text-[#555] uppercase tracking-wider mb-1 block">Phase Residual</span>
          <FmcwMiniPlot data={result.residual_plot} yLabel="rad" color="#A78BFA" />
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value, pass }) {
  return (
    <div className={cn(
      'flex flex-col gap-1 p-3 rounded-xl border',
      pass === true ? 'border-emerald-400/20 bg-emerald-400/5' :
      pass === false ? 'border-red-400/20 bg-red-400/5' :
      'border-white/5 bg-[#0a0a0a]/60'
    )}>
      <span className="text-[9px] font-medium uppercase tracking-wider text-[#555]">{label}</span>
      <span className="text-sm font-bold font-mono text-white">{value}</span>
    </div>
  );
}

function FmcwMiniPlot({ data, yLabel, color }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const pad = { top: 8, bottom: 20, left: 40, right: 8 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    let yMin = Infinity, yMax = -Infinity;
    for (const v of data) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    const yRange = yMax - yMin || 1;
    yMin -= yRange * 0.05;
    yMax += yRange * 0.05;

    // Grid
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (i / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText((yMax - (i / 4) * (yMax - yMin)).toFixed(1), pad.left - 4, y + 3);
    }

    // Trace
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (i / (data.length - 1)) * plotW;
      const y = pad.top + ((yMax - data[i]) / (yMax - yMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Y-axis label
    ctx.fillStyle = '#444';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(yLabel, pad.left / 2, h - 4);
  }, [data, yLabel, color]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded border border-white/5"
      style={{ height: '120px' }}
    />
  );
}
