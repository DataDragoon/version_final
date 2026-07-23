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

function drawHeatmap(ctx, x0, y0, plotW, plotH, dataMap, numPos, numDepthBins, dMin, dMax) {
  const cellW = plotW / numPos;
  const cellH = plotH / numDepthBins;
  for (let xi = 0; xi < numPos; xi++) {
    for (let yi = 0; yi < numDepthBins; yi++) {
      const val = dataMap[xi * numDepthBins + yi];
      const t = (val - dMin) / (dMax - dMin);
      const [r, g, b] = heatmap(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(
        x0 + xi * cellW,
        y0 + yi * cellH,
        Math.ceil(cellW) + 1,
        Math.ceil(cellH) + 1
      );
    }
  }
}

function drawAxesAndGrid(ctx, pad, plotW, plotH, w, h, numPos, numDepthBins, depthAxis, stepSize, params, useSlope, dMin, dMax, title) {
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.4;
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (i / yTicks) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
  }
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (i / xTicks) * plotW;
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  const maxDepth = depthAxis[numDepthBins - 1];
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (i / yTicks) * plotH;
    const depth = (i / yTicks) * maxDepth;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${depth.toFixed(1)}`, pad.left - 4, y + 3);
  }

  const apertureLen = (numPos - 1) * stepSize;
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (i / xTicks) * plotW;
    const pos = (i / xTicks) * apertureLen;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${pos.toFixed(0)}`, x, pad.top + plotH + 12);
  }

  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Position (cm)', pad.left + plotW / 2, pad.top + plotH + 24);

  ctx.save();
  ctx.translate(10, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Depth (cm)', 0, 0);
  ctx.restore();

  ctx.fillStyle = '#60a5fa';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(title, pad.left, pad.top - 8);

  // Color bar
  const barW = 10;
  const barH = plotH;
  const barX = pad.left + plotW + 6;
  const barY = pad.top;
  for (let i = 0; i < barH; i++) {
    const t = 1 - i / barH;
    const [r, g, b] = heatmap(t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(barX, barY + i, barW, 1);
  }
  ctx.fillStyle = '#555555';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${dMax}`, barX, barY - 4);
  ctx.fillText(`${dMin}`, barX, barY + barH + 10);
}

export default function SeepageDisplay({ result, params, progress }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  const hasSub = result && result.subAmplitudeMap;

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
    const { mode, dbFloor, dbCeil, slopeMin, slopeMax } = params;

    const useSlope = mode === 'spectral';
    const rawMap = useSlope ? spectralSlopeMap : amplitudeMap;
    const dMin = useSlope ? slopeMin : dbFloor;
    const dMax = useSlope ? slopeMax : dbCeil;
    const modeLabel = useSlope ? 'SPECTRAL SLOPE' : 'AMPLITUDE';

    if (!subAmplitudeMap) {
      // Single view (no reference)
      const pad = { top: 32, bottom: 40, left: 52, right: 36 };
      const plotW = w - pad.left - pad.right;
      const plotH = h - pad.top - pad.bottom;

      drawHeatmap(ctx, pad.left, pad.top, plotW, plotH, rawMap, numPos, numDepthBins, dMin, dMax);
      drawAxesAndGrid(ctx, pad, plotW, plotH, w, h, numPos, numDepthBins, depthAxis, stepSize, params, useSlope, dMin, dMax, `RAW — ${modeLabel}`);

      // Crosshair
      if (crosshair) {
        drawCrosshair(ctx, crosshair, pad, plotW, plotH, rawMap, numPos, numDepthBins, depthAxis, stepSize, dMin, dMax, useSlope, w, h);
      }
    } else {
      // Split view: left = raw, right = subtracted
      const gap = 16;
      const halfW = (w - gap) / 2;

      // Left: raw
      const padL = { top: 32, bottom: 40, left: 52, right: 28 };
      const plotWL = halfW - padL.left - padL.right;
      const plotHL = h - padL.top - padL.bottom;

      drawHeatmap(ctx, padL.left, padL.top, plotWL, plotHL, rawMap, numPos, numDepthBins, dMin, dMax);
      drawAxesAndGrid(ctx, padL, plotWL, plotHL, halfW, h, numPos, numDepthBins, depthAxis, stepSize, params, useSlope, dMin, dMax, `RAW — ${modeLabel}`);

      // Divider
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(halfW + gap / 2, 8);
      ctx.lineTo(halfW + gap / 2, h - 8);
      ctx.stroke();

      // Right: subtracted
      const subMap = useSlope ? subSpectralSlopeMap : subAmplitudeMap;
      const padR = { top: 32, bottom: 40, left: halfW + gap + 12, right: 36 };
      const plotWR = w - padR.left - padR.right;
      const plotHR = h - padR.top - padR.bottom;

      drawHeatmap(ctx, padR.left, padR.top, plotWR, plotHR, subMap, numPos, numDepthBins, dMin, dMax);
      drawAxesAndGrid(ctx, padR, plotWR, plotHR, w, h, numPos, numDepthBins, depthAxis, stepSize, params, useSlope, dMin, dMax, `REF SUBTRACTED — ${modeLabel}`);

      // Crosshair on whichever side the mouse is on
      if (crosshair) {
        if (crosshair.x < halfW) {
          drawCrosshair(ctx, crosshair, padL, plotWL, plotHL, rawMap, numPos, numDepthBins, depthAxis, stepSize, dMin, dMax, useSlope, halfW, h);
        } else {
          const adjusted = { x: crosshair.x, y: crosshair.y };
          drawCrosshair(ctx, adjusted, padR, plotWR, plotHR, subMap, numPos, numDepthBins, depthAxis, stepSize, dMin, dMax, useSlope, w, h);
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

function drawCrosshair(ctx, crosshair, pad, plotW, plotH, dataMap, numPos, numDepthBins, depthAxis, stepSize, dMin, dMax, useSlope, maxX, h) {
  const relX = (crosshair.x - pad.left) / plotW;
  const relY = (crosshair.y - pad.top) / plotH;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

  const xi = Math.min(numPos - 1, Math.floor(relX * numPos));
  const yi = Math.min(numDepthBins - 1, Math.floor(relY * numDepthBins));
  const positionCm = xi * stepSize;
  const depthCm = depthAxis[yi];
  const val = dataMap[xi * numDepthBins + yi];

  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#ffffff44';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(crosshair.x, pad.top); ctx.lineTo(crosshair.x, pad.top + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.left, crosshair.y); ctx.lineTo(pad.left + plotW, crosshair.y); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#ffffff';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  const unit = useSlope ? 'dB slope' : 'dB';
  const label = `${positionCm.toFixed(0)}cm, ${depthCm.toFixed(1)}cm deep, ${val.toFixed(1)} ${unit}`;
  const labelX = crosshair.x + 10 > maxX - 180 ? crosshair.x - 180 : crosshair.x + 10;
  ctx.fillText(label, labelX, crosshair.y - 8);
}
