import { useRef, useEffect, useCallback, useState } from 'react';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';

function hot(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * Math.min(1, t * 2.5));
  const g = Math.round(255 * Math.max(0, Math.min(1, (t - 0.4) * 2.5)));
  const b = Math.round(255 * Math.max(0, Math.min(1, (t - 0.7) * 3.3)));
  return [r, g, b];
}

export default function SarDisplay({ sarResult, sarParams }) {
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

    if (!sarResult || !sarResult.image) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No SAR image — run reconstruction from B-scan data', w / 2, h / 2);
      return;
    }

    const { image, pixelsX, pixelsZ, depthMin, depthMax, lateralMin, lateralMax } = sarResult;
    const { dbFloor, dbCeil, wallEnabled, wallStandoff, wallThickness } = sarParams;

    const pad = { top: 32, bottom: 40, left: 60, right: 30 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Draw SAR image — X axis = lateral, Y axis = depth
    const cellW = plotW / pixelsX;
    const cellH = plotH / pixelsZ;

    for (let xi = 0; xi < pixelsX; xi++) {
      for (let zi = 0; zi < pixelsZ; zi++) {
        const db = image[zi * pixelsX + xi];
        const t = (db - dbFloor) / (dbCeil - dbFloor);
        const [r, g, b] = hot(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const x = pad.left + xi * cellW;
        const y = pad.top + zi * cellH;
        ctx.fillRect(x, y, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
      }
    }

    // Grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.4;

    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // Y-axis labels (depth)
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      const depth = depthMin + (i / yTicks) * (depthMax - depthMin);
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${depth.toFixed(2)} m`, pad.left - 6, y + 3);
    }

    // X-axis labels (lateral position)
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (i / xTicks) * plotW;
      const lat = lateralMin + (i / xTicks) * (lateralMax - lateralMin);
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${(lat * 100).toFixed(1)} cm`, x, h - pad.bottom + 14);
    }

    // Axis titles
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Lateral Position (cm)', pad.left + plotW / 2, h - pad.bottom + 28);

    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Depth (m)', 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SAR IMAGE', pad.left, 16);

    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    const modeLabel = sarResult.coherent ? 'coherent' : 'incoherent';
    ctx.fillText(`${pixelsX}×${pixelsZ} | ${sarResult.numPositions} pos | ${modeLabel}`, w - pad.right, 16);

    // Color bar
    const barW = 12;
    const barH = plotH;
    const barX = w - pad.right + 6;
    const barY = pad.top;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const [r, g, b] = hot(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(barX, barY + i, barW, 1);
    }
    ctx.fillStyle = '#555555';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${dbCeil}`, barX, barY - 4);
    ctx.fillText(`${dbFloor}`, barX, barY + barH + 10);

    // Wall boundary indicators
    if (wallEnabled) {
      const wallFrontM = (wallStandoff || 5) / 100;
      const wallBackM = wallFrontM + (wallThickness || 15) / 100;
      const depthRange = depthMax - depthMin;

      const drawWallLine = (depthM, label) => {
        if (depthM < depthMin || depthM > depthMax) return;
        const yFrac = (depthM - depthMin) / depthRange;
        const y = pad.top + yFrac * plotH;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#f59e0b88';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f59e0b';
        ctx.font = '8px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(label, pad.left + 4, y - 3);
      };

      drawWallLine(wallFrontM, 'wall front');
      drawWallLine(wallBackM, 'wall back');
    }

    // Crosshair
    if (crosshair) {
      const relX = (crosshair.x - pad.left) / plotW;
      const relY = (crosshair.y - pad.top) / plotH;
      if (relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1) {
        const xi = Math.min(pixelsX - 1, Math.floor(relX * pixelsX));
        const zi = Math.min(pixelsZ - 1, Math.floor(relY * pixelsZ));
        const lat = lateralMin + relX * (lateralMax - lateralMin);
        const depth = depthMin + relY * (depthMax - depthMin);
        const db = image[zi * pixelsX + xi];

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
        const label = `${(lat * 100).toFixed(1)}cm, ${depth.toFixed(3)}m, ${db.toFixed(1)}dB`;
        const labelX = crosshair.x + 10 > w - 180 ? crosshair.x - 180 : crosshair.x + 10;
        ctx.fillText(label, labelX, crosshair.y - 8);
      }
    }
  }, [sarResult, sarParams, crosshair]);

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
