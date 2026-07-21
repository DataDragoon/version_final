import { useRef, useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';
const TRACE_COLOR = '#A78BFA';
const TRACE_COLOR_ALT = '#C4B5FD';

export default function HwCalDisplay({ calResult, calMode }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const latestResult = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  useEffect(() => {
    if (calResult) {
      latestResult.current = calResult;
    }
  }, [calResult]);

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
