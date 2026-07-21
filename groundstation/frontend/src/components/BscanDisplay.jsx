import { useRef, useEffect, useCallback, useState } from 'react';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';

function jet(t) {
  t = Math.max(0, Math.min(1, t));
  return [
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)))),
  ];
}

export default function BscanDisplay({ scanData, params, capturing, sfcwProgress, dbFloor = -90, dbCeil = -20 }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

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

    if (!scanData || scanData.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No scan data — capture positions to build B-scan', w / 2, h / 2);
      return;
    }

    const pad = { top: 32, bottom: 40, left: 60, right: 20 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const numPos = scanData.length;
    const numBins = scanData[0].magnitudes.length;
    const distances = scanData[0].distances;
    const maxDist = distances[distances.length - 1];
    const { stepSize } = params;
    const apertureLen = (numPos - 1) * stepSize;

    // Dynamic range
    const dbMin = dbFloor;
    const dbMax = dbCeil;

    // Draw B-scan image
    const cellW = plotW / numPos;
    const cellH = plotH / numBins;

    for (let posIdx = 0; posIdx < numPos; posIdx++) {
      const mags = scanData[posIdx].magnitudes;
      for (let binIdx = 0; binIdx < numBins; binIdx++) {
        const db = mags[binIdx];
        const t = (db - dbMin) / (dbMax - dbMin);
        const [r, g, b] = jet(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const x = pad.left + posIdx * cellW;
        const y = pad.top + binIdx * cellH;
        ctx.fillRect(x, y, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
      }
    }

    // Grid overlay
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.4;

    // Y-axis (range) ticks
    const yTicks = 6;
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    // X-axis (position) ticks
    const xTicks = Math.min(numPos, 10);
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // Y-axis labels (range)
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      const dist = (i / yTicks) * maxDist;
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${dist.toFixed(1)} m`, pad.left - 6, y + 3);
    }

    // X-axis labels (position)
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      const pos = (i / xTicks) * apertureLen;
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${pos.toFixed(1)}`, x, h - pad.bottom + 14);
    }

    // Axis titles
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Position (cm)', pad.left + plotW / 2, h - pad.bottom + 28);

    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Range (m)', 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = '#6B9BD2';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('B-SCAN', pad.left, 16);

    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${numPos} positions × ${numBins} bins`, w - pad.right, 16);

    // Color bar
    const barW = 12;
    const barH = plotH;
    const barX = w - pad.right + 6;
    const barY = pad.top;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const [r, g, b] = jet(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(barX, barY + i, barW, 1);
    }
    ctx.fillStyle = '#555555';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${dbMax} dB`, barX, barY - 4);
    ctx.fillText(`${dbMin} dB`, barX, barY + barH + 10);

    // Crosshair
    if (crosshair) {
      const relX = (crosshair.x - pad.left) / plotW;
      const relY = (crosshair.y - pad.top) / plotH;
      if (relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1) {
        const posIdx = Math.min(numPos - 1, Math.floor(relX * numPos));
        const binIdx = Math.min(numBins - 1, Math.floor(relY * numBins));
        const dist = distances[binIdx];
        const pos = posIdx * stepSize;
        const db = scanData[posIdx].magnitudes[binIdx];

        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffffff44';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(crosshair.x, pad.top);
        ctx.lineTo(crosshair.x, h - pad.bottom);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pad.left, crosshair.y);
        ctx.lineTo(w - pad.right, crosshair.y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        const label = `${pos.toFixed(1)}cm, ${dist.toFixed(2)}m, ${db.toFixed(1)}dB`;
        const labelX = crosshair.x + 10 > w - 150 ? crosshair.x - 150 : crosshair.x + 10;
        ctx.fillText(label, labelX, crosshair.y - 8);
      }
    }
  }, [scanData, params, crosshair, dbFloor, dbCeil]);

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
      {capturing && sfcwProgress && (
        <div className="absolute top-0 left-0 right-0 z-10 h-0.5">
          <div
            className="h-full bg-gradient-to-r from-[#6B9BD2] to-[#8BB8E8] transition-all duration-200"
            style={{ width: `${(sfcwProgress.step / sfcwProgress.total) * 100}%` }}
          />
        </div>
      )}
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
