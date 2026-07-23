import { useEffect, useRef, useState, useCallback } from 'react';
import SarWorker from '../lib/sar.worker.js?worker';

export function useSarWorker(bscanData, bscanParams, sarParams) {
  const [sarResult, setSarResult] = useState(null);
  const [sarProgress, setSarProgress] = useState(null); // null = idle, 0-1 = running
  const workerRef = useRef(null);
  const debounceRef = useRef(null);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new SarWorker();
      workerRef.current.onmessage = (e) => {
        if (e.data.type === 'progress') {
          setSarProgress(e.data.progress);
        } else if (e.data.type === 'result') {
          setSarResult(e.data.result);
          setSarProgress(null);
        }
      };
    }
    return workerRef.current;
  }, []);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!bscanData || bscanData.length < 2) {
      setSarResult(null);
      setSarProgress(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      setSarProgress(0);
      const worker = getWorker();
      worker.postMessage({ bscanData, bscanParams, sarParams });
    }, 150);
  }, [bscanData, bscanParams, sarParams, getWorker]);

  return { sarResult, sarProgress };
}
