import { useRef, useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';
const TRACE_COLOR = '#D1855C';
const PEAK_COLOR = '#E5A986';
const FILL_COLOR = 'rgba(209, 133, 92, 0.15)';

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
  const waterfallCanvasRef = useRef(null);
  const animRef = useRef(null);
  const latestResult = useRef(null);
  const waterfallData = useRef([]);
  const [crosshair, setCrosshair] = useState(null);

  useEffect(() => {
    if (sfcwResult) {
      latestResult.current = sfcwResult;
      // Add to waterfall history
      if (sfcwResult.magnitudes && sfcwResult.magnitudes.length > 0) {
        waterfallData.current.push(sfcwResult.magnitudes.slice());
        if (waterfallData.current.length > 80) {
          waterfallData.current.shift();
        }
      }
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
    const pad = { top: 30, bottom: 36, left: 52, right: 16 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Auto-scale: use floor/ceil from props but ensure peak is visible
    const peak = result.peak || {};
    let magMin = dbFloor;
    let magMax = dbCeil;

    // If auto-scale would help, tighten around the data
    const dataMax = Math.max(...mags);
    const dataMin = Math.min(...mags);
    if (dataMax > magMax) magMax = Math.ceil(dataMax / 5) * 5 + 5;
    if (dataMin < magMin) magMin = Math.floor(dataMin / 5) * 5;
    // Ensure at least 20 dB dynamic range visible
    if (magMax - magMin < 20) {
      magMin = magMax - 20;
    }

    const maxDist = dists[dists.length - 1];

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
      ctx.fillText(`${val.toFixed(0)}`, pad.left - 6, y + 3);
    }

    // X-axis: distance markers every 0.5m
    const xStep = 0.5;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (let d = 0; d <= maxDist; d += xStep) {
      const x = pad.left + (d / maxDist) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      ctx.fillText(`${d.toFixed(1)}`, x, h - pad.bottom + 14);
    }

    // Filled area under trace
    ctx.beginPath();
    ctx.moveTo(pad.left, h - pad.bottom);
    for (let i = 0; i < n; i++) {
      const x = pad.left + (i / (n - 1)) * plotW;
      const y = pad.top + ((magMax - mags[i]) / (magMax - magMin)) * plotH;
      ctx.lineTo(x, Math.min(y, h - pad.bottom));
    }
    ctx.lineTo(pad.left + plotW, h - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = FILL_COLOR;
    ctx.fill();

    // Trace
    ctx.beginPath();
    ctx.strokeStyle = TRACE_COLOR;
    ctx.lineWidth = 2;
    for (let i = 0; i < n; i++) {
      const x = pad.left + (i / (n - 1)) * plotW;
      const y = pad.top + ((magMax - mags[i]) / (magMax - magMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Peak marker and annotation
    if (peak.distance_m !== undefined) {
      const peakX = pad.left + (peak.distance_m / maxDist) * plotW;
      const peakY = pad.top + ((magMax - peak.magnitude_db) / (magMax - magMin)) * plotH;

      // Vertical dashed line at peak
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = PEAK_COLOR + '88';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(peakX, pad.top);
      ctx.lineTo(peakX, h - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Peak dot
      ctx.beginPath();
      ctx.arc(peakX, peakY, 5, 0, Math.PI * 2);
      ctx.fillStyle = PEAK_COLOR;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Peak label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = peakX > w / 2 ? 'right' : 'left';
      const labelX = peakX > w / 2 ? peakX - 10 : peakX + 10;
      ctx.fillText(`${peak.distance_m.toFixed(2)} m`, labelX, peakY - 14);
      ctx.fillStyle = '#aaaaaa';
      ctx.font = '9px monospace';
      ctx.fillText(`${peak.magnitude_db.toFixed(1)} dB  SNR ${peak.snr_db.toFixed(0)} dB`, labelX, peakY - 2);
    }

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

    // Title bar
    ctx.fillStyle = '#666666';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RANGE PROFILE', pad.left, 14);

    // Info badges
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    let infoX = w - pad.right;
    if (result.range_resolution) {
      ctx.fillStyle = '#444444';
      ctx.fillText(`Δr=${(result.range_resolution * 100).toFixed(1)}cm`, infoX, 14);
    }
    if (result.avg_count) {
      ctx.fillStyle = '#444444';
      ctx.fillText(`avg=${result.avg_count}`, infoX - 80, 14);
    }
    if (result.phase_coherence) {
      const pc = result.phase_coherence;
      const color = pc.coherent ? '#4ade80' : '#ef4444';
      ctx.fillStyle = color;
      ctx.fillText(
        `φ=${pc.phase_std_deg.toFixed(1)}°`,
        infoX, 26
      );
    }

    // dB axis label
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('dB', 0, 0);
    ctx.restore();

    // Distance axis label
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Distance (m)', pad.left + plotW / 2, h - 4);
  }, [crosshair, dbFloor, dbCeil]);

  const drawWaterfall = useCallback(() => {
    const canvas = waterfallCanvasRef.current;
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

    const history = waterfallData.current;
    if (history.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No waterfall data', w / 2, h / 2);
      return;
    }

    const pad = { top: 16, bottom: 4, left: 52, right: 16 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const dbMin = dbFloor;
    const dbMax = dbCeil;
    const numRows = history.length;
    const rowH = plotH / Math.max(numRows, 1);

    for (let row = 0; row < numRows; row++) {
      const mags = history[row];
      const n = mags.length;
      const cellW = plotW / n;
      const y = pad.top + (numRows - 1 - row) * rowH;

      for (let i = 0; i < n; i++) {
        const t = (mags[i] - dbMin) / (dbMax - dbMin);
        const [r, g, b] = jet(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(pad.left + i * cellW, y, Math.ceil(cellW) + 1, Math.ceil(rowH) + 1);
      }
    }

    // Title
    ctx.fillStyle = '#6B9BD2';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('WATERFALL', pad.left, 12);

    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${numRows} sweeps`, w - pad.right, 12);
  }, [dbFloor, dbCeil]);

  useEffect(() => {
    const render = () => {
      drawRange();
      drawWaterfall();
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [drawRange, drawWaterfall]);

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

      {/* Range Profile — 70% */}
      <div className="relative flex-[7] min-h-0">
        <canvas
          ref={rangeCanvasRef}
          className="absolute inset-0 w-full h-full"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </div>

      {/* Waterfall — 30% */}
      <div className="relative flex-[3] min-h-0 border-t border-white/5">
        <canvas
          ref={waterfallCanvasRef}
          className="absolute inset-0 w-full h-full"
        />
      </div>
    </div>
  );
}
