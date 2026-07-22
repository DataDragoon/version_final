import { useRef, useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';
const TRACE_COLOR = '#D1855C';
const PEAK_COLOR = '#E5A986';

function jet(t) {
  t = Math.max(0, Math.min(1, t));
  return [
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)))),
  ];
}

export default function SfcwDisplay({ sfcwResult, sfcwProgress, sfcwRunning, dbFloor = -90, dbCeil = -20 }) {
  const rangeCanvasRef = useRef(null);
  const colormapCanvasRef = useRef(null);
  const animRef = useRef(null);
  const latestResult = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  useEffect(() => {
    if (sfcwResult) {
      latestResult.current = sfcwResult;
    }
  }, [sfcwResult]);

  const drawRange = useCallback(() => {
    const canvas = rangeCanvasRef.current;
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
    if (!result || !result.magnitudes || result.magnitudes.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No sweep data', w / 2, h / 2);
      return;
    }

    const mags = result.magnitudes;
    const dists = result.distances;
    const n = mags.length;
    const pad = { top: 24, bottom: 36, left: 52, right: 16 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const magMin = dbFloor;
    const magMax = dbCeil;

    // Grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      const val = magMax - (i / yTicks) * (magMax - magMin);
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${val.toFixed(0)} dB`, pad.left - 6, y + 3);
    }

    const maxDist = dists[dists.length - 1];
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      const dist = (i / xTicks) * maxDist;
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${dist.toFixed(1)} m`, x, h - pad.bottom + 14);
    }

    // Reference overlay traces (current & aligned reference — dotted)
    if (result.ref_trace && result.cur_trace) {
      const refT = result.ref_trace;
      const curT = result.cur_trace;
      const traceN = Math.min(refT.length, n);

      // Current scan (before subtraction) — dotted white
      ctx.beginPath();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ffffff55';
      ctx.lineWidth = 1;
      for (let i = 0; i < traceN; i++) {
        const x = pad.left + (i / (n - 1)) * plotW;
        const y = pad.top + ((magMax - curT[i]) / (magMax - magMin)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Aligned reference — dotted cyan
      ctx.beginPath();
      ctx.strokeStyle = '#22d3ee55';
      ctx.lineWidth = 1;
      for (let i = 0; i < traceN; i++) {
        const x = pad.left + (i / (n - 1)) * plotW;
        const y = pad.top + ((magMax - refT[i]) / (magMax - magMin)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trace (subtracted result — solid)
    ctx.beginPath();
    ctx.strokeStyle = TRACE_COLOR;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const x = pad.left + (i / (n - 1)) * plotW;
      const y = pad.top + ((magMax - mags[i]) / (magMax - magMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Peak
    let peakIdx = 0;
    let peakVal = -Infinity;
    for (let i = 1; i < n; i++) {
      if (mags[i] > peakVal) {
        peakVal = mags[i];
        peakIdx = i;
      }
    }
    const peakX = pad.left + (peakIdx / (n - 1)) * plotW;
    const peakY = pad.top + ((magMax - peakVal) / (magMax - magMin)) * plotH;
    ctx.beginPath();
    ctx.arc(peakX, peakY, 3, 0, Math.PI * 2);
    ctx.fillStyle = PEAK_COLOR;
    ctx.fill();
    ctx.fillStyle = PEAK_COLOR;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${dists[peakIdx].toFixed(2)} m`, peakX, peakY - 8);

    // Crosshair
    if (crosshair) {
      const { x: mx } = crosshair;
      const relX = (mx - pad.left) / plotW;
      if (relX >= 0 && relX <= 1) {
        const idx = Math.round(relX * (n - 1));
        const cx = pad.left + (idx / (n - 1)) * plotW;
        const cy = pad.top + ((magMax - mags[idx]) / (magMax - magMin)) * plotH;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffffff44';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, pad.top);
        ctx.lineTo(cx, h - pad.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${dists[idx].toFixed(2)} m  ${mags[idx].toFixed(1)} dB`, cx + 8, cy - 4);
      }
    }

    // Title
    ctx.fillStyle = '#666666';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RANGE PROFILE', pad.left, 14);
    if (result.range_resolution) {
      ctx.fillStyle = '#444444';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`Δr=${(result.range_resolution * 100).toFixed(1)}cm`, w - pad.right, 14);
    }

    // Phase coherence indicator
    if (result.phase_coherence) {
      const pc = result.phase_coherence;
      const color = pc.coherent ? '#4ade80' : '#ef4444';
      ctx.fillStyle = color;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(
        `φ σ=${pc.phase_std_deg.toFixed(1)}° ${pc.coherent ? '● COHERENT' : '● INCOHERENT'}`,
        w - pad.right, 26
      );
    }
  }, [crosshair, dbFloor, dbCeil]);

  const drawColormap = useCallback(() => {
    const canvas = colormapCanvasRef.current;
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
    if (!result || !result.magnitudes || result.magnitudes.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No sweep data', w / 2, h / 2);
      return;
    }

    const mags = result.magnitudes;
    const dists = result.distances;
    const n = mags.length;
    const pad = { top: 24, bottom: 36, left: 52, right: 16 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const dbMin = dbFloor;
    const dbMax = dbCeil;

    // Draw horizontal colormap strip — each bin is a colored column
    const cellW = plotW / n;
    for (let i = 0; i < n; i++) {
      const t = (mags[i] - dbMin) / (dbMax - dbMin);
      const [r, g, b] = jet(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const x = pad.left + i * cellW;
      ctx.fillRect(x, pad.top, Math.ceil(cellW) + 1, plotH);
    }

    // X-axis labels (distance)
    const maxDist = dists[dists.length - 1];
    const xTicks = 6;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      const dist = (i / xTicks) * maxDist;
      ctx.fillText(`${dist.toFixed(1)} m`, x, h - pad.bottom + 14);
    }

    // Color bar legend (vertical, right side)
    const barW = 10;
    const barX = w - pad.right + 4;
    const barH = plotH;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const [r, g, b] = jet(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(barX, pad.top + i, barW, 1);
    }
    ctx.fillStyle = '#555555';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${dbMax}`, barX, pad.top - 4);
    ctx.fillText(`${dbMin}`, barX, pad.top + barH + 10);

    // Title
    ctx.fillStyle = '#6B9BD2';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('COLORMAP', pad.left, 14);

    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${dbMin} to ${dbMax} dB`, w - pad.right - 16, 14);
  }, [dbFloor, dbCeil]);

  useEffect(() => {
    const render = () => {
      drawRange();
      drawColormap();
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [drawRange, drawColormap]);

  const handleMouseMove = (e) => {
    const rect = rangeCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const handleMouseLeave = () => setCrosshair(null);

  return (
    <div className="flex flex-col w-full h-full">
      {/* Progress bar */}
      {sfcwRunning && sfcwProgress && (
        <div className="absolute top-0 left-0 right-0 z-10 h-0.5">
          <div
            className="h-full bg-gradient-to-r from-[#D1855C] to-[#E5A986] transition-all duration-200"
            style={{ width: `${(sfcwProgress.step / sfcwProgress.total) * 100}%` }}
          />
        </div>
      )}

      {/* Range Profile */}
      <div className="relative flex-1 min-h-0">
        <canvas
          ref={rangeCanvasRef}
          className="absolute inset-0 w-full h-full"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </div>

      {/* Colormap strip */}
      <div className="relative border-t border-white/5" style={{ flex: '0 0 25%' }}>
        <canvas
          ref={colormapCanvasRef}
          className="absolute inset-0 w-full h-full"
        />
      </div>
    </div>
  );
}
