import { useRef, useEffect, useCallback, useState } from 'react';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';

function heatmap(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.33) {
    const s = t / 0.33;
    r = 0; g = Math.round(80 * s); b = Math.round(180 + 75 * s);
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    r = Math.round(255 * s); g = Math.round(80 + 175 * s); b = Math.round(255 * (1 - s));
  } else {
    const s = (t - 0.66) / 0.34;
    r = 255; g = Math.round(255 * (1 - s * 0.7)); b = 0;
  }
  return [r, g, b];
}

function drawPanel(ctx, ox, oy, pw, ph, dataMap, numPos, numDepthBins, depthAxis, stepSize, dMin, dMax, title, unit) {
  const pad = { top: 24, bottom: 28, left: 42, right: 28 };
  const plotW = pw - pad.left - pad.right;
  const plotH = ph - pad.top - pad.bottom;

  const cellW = plotW / numPos;
  const cellH = plotH / numDepthBins;

  // Heatmap
  for (let xi = 0; xi < numPos; xi++) {
    for (let yi = 0; yi < numDepthBins; yi++) {
      const val = dataMap[xi * numDepthBins + yi];
      const t = (val - dMin) / (dMax - dMin);
      const [r, g, b] = heatmap(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(
        ox + pad.left + xi * cellW,
        oy + pad.top + yi * cellH,
        Math.ceil(cellW) + 1,
        Math.ceil(cellH) + 1
      );
    }
  }

  // Grid
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.3;
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const y = oy + pad.top + (i / yTicks) * plotH;
    ctx.beginPath(); ctx.moveTo(ox + pad.left, y); ctx.lineTo(ox + pad.left + plotW, y); ctx.stroke();
  }
  const xTicks = 4;
  for (let i = 0; i <= xTicks; i++) {
    const x = ox + pad.left + (i / xTicks) * plotW;
    ctx.beginPath(); ctx.moveTo(x, oy + pad.top); ctx.lineTo(x, oy + pad.top + plotH); ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  // Y labels (depth)
  const maxDepth = depthAxis[numDepthBins - 1];
  for (let i = 0; i <= yTicks; i++) {
    const y = oy + pad.top + (i / yTicks) * plotH;
    const depth = (i / yTicks) * maxDepth;
    ctx.fillStyle = '#555555';
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${depth.toFixed(1)}`, ox + pad.left - 4, y + 3);
  }

  // X labels (position)
  const apertureLen = (numPos - 1) * stepSize;
  for (let i = 0; i <= xTicks; i++) {
    const x = ox + pad.left + (i / xTicks) * plotW;
    const pos = (i / xTicks) * apertureLen;
    ctx.fillStyle = '#555555';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${pos.toFixed(0)}`, x, oy + pad.top + plotH + 10);
  }

  // Axis labels
  ctx.fillStyle = '#444444';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('pos (cm)', ox + pad.left + plotW / 2, oy + pad.top + plotH + 22);

  // Title
  ctx.fillStyle = '#60a5fa';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(title, ox + pad.left, oy + 12);

  // Color bar
  const barW = 8;
  const barH = plotH;
  const barX = ox + pad.left + plotW + 4;
  const barY = oy + pad.top;
  for (let i = 0; i < barH; i++) {
    const t = 1 - i / barH;
    const [r, g, b] = heatmap(t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(barX, barY + i, barW, 1);
  }
  ctx.fillStyle = '#555555';
  ctx.font = '7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${dMax}`, barX + barW + 2, barY + 4);
  ctx.fillText(`${dMin}`, barX + barW + 2, barY + barH);

  return { ox: ox + pad.left, oy: oy + pad.top, plotW, plotH };
}

export default function SeepageDisplay({ result, params, progress }) {
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

    if (!result) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No scan data — capture positions along wall surface', w / 2, h / 2);
      return;
    }

    const { amplitudeMap, spectralSlopeMap, subAmplitudeMap, subSpectralSlopeMap, numPos, numDepthBins, depthAxis, stepSize } = result;
    const { dbFloor, dbCeil, subDbFloor, subDbCeil, slopeMin, slopeMax } = params;

    const hasSub = !!subAmplitudeMap;
    const gap = 8;

    const panels = [];

    if (hasSub) {
      // 2x2 grid
      const cellW = (w - gap) / 2;
      const cellH = (h - gap) / 2;

      panels.push({ ox: 0, oy: 0, pw: cellW, ph: cellH, map: amplitudeMap, dMin: dbFloor, dMax: dbCeil, title: 'RAW AMPLITUDE', unit: 'dB' });
      panels.push({ ox: cellW + gap, oy: 0, pw: cellW, ph: cellH, map: spectralSlopeMap, dMin: slopeMin, dMax: slopeMax, title: 'RAW SPECTRAL SLOPE', unit: 'dB slope' });
      panels.push({ ox: 0, oy: cellH + gap, pw: cellW, ph: cellH, map: subAmplitudeMap, dMin: subDbFloor, dMax: subDbCeil, title: 'REF SUB — AMPLITUDE', unit: 'dB' });
      panels.push({ ox: cellW + gap, oy: cellH + gap, pw: cellW, ph: cellH, map: subSpectralSlopeMap, dMin: slopeMin, dMax: slopeMax, title: 'REF SUB — SPECTRAL', unit: 'dB slope' });
    } else {
      // Side by side (no reference)
      const cellW = (w - gap) / 2;

      panels.push({ ox: 0, oy: 0, pw: cellW, ph: h, map: amplitudeMap, dMin: dbFloor, dMax: dbCeil, title: 'AMPLITUDE', unit: 'dB' });
      panels.push({ ox: cellW + gap, oy: 0, pw: cellW, ph: h, map: spectralSlopeMap, dMin: slopeMin, dMax: slopeMax, title: 'SPECTRAL SLOPE', unit: 'dB slope' });
    }

    const panelBounds = [];
    for (const p of panels) {
      const bounds = drawPanel(ctx, p.ox, p.oy, p.pw, p.ph, p.map, numPos, numDepthBins, depthAxis, stepSize, p.dMin, p.dMax, p.title, p.unit);
      panelBounds.push({ ...bounds, map: p.map, dMin: p.dMin, dMax: p.dMax, unit: p.unit });
    }

    // Crosshair
    if (crosshair) {
      for (const b of panelBounds) {
        const relX = (crosshair.x - b.ox) / b.plotW;
        const relY = (crosshair.y - b.oy) / b.plotH;
        if (relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1) {
          const xi = Math.min(numPos - 1, Math.floor(relX * numPos));
          const yi = Math.min(numDepthBins - 1, Math.floor(relY * numDepthBins));
          const positionCm = xi * stepSize;
          const depthCm = depthAxis[yi];
          const val = b.map[xi * numDepthBins + yi];

          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#ffffff44';
          ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(crosshair.x, b.oy); ctx.lineTo(crosshair.x, b.oy + b.plotH); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(b.ox, crosshair.y); ctx.lineTo(b.ox + b.plotW, crosshair.y); ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#ffffff';
          ctx.font = '10px monospace';
          ctx.textAlign = 'left';
          const label = `${positionCm.toFixed(0)}cm, ${depthCm.toFixed(1)}cm, ${val.toFixed(1)} ${b.unit}`;
          const labelX = crosshair.x + 10 > b.ox + b.plotW - 160 ? crosshair.x - 160 : crosshair.x + 10;
          ctx.fillText(label, labelX, crosshair.y - 8);
          break;
        }
      }
    }
  }, [result, params, crosshair]);

  useEffect(() => {
    const render = () => { draw(); animRef.current = requestAnimationFrame(render); };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw]);

  const handleMouseMove = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div className="flex flex-col w-full h-full">
      <div className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setCrosshair(null)}
        />
      </div>
    </div>
  );
}
