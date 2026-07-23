import { useEffect, useRef, useState, useCallback } from 'react';
import SeepageWorker from '../lib/seepage.worker.js?worker';

export function useSeepageWorker(scanData, params, referenceData) {
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const workerRef = useRef(null);
  const debounceRef = useRef(null);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new SeepageWorker();
      workerRef.current.onmessage = (e) => {
        if (e.data.type === 'progress') {
          setProgress(e.data.progress);
        } else if (e.data.type === 'result') {
          setResult(e.data.result);
          setProgress(null);
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

    if (!scanData || scanData.length === 0) {
      setResult(null);
      setProgress(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      setProgress(0);
      const worker = getWorker();
      worker.postMessage({ scanData, params, referenceData: referenceData || null });
    }, 100);
  }, [scanData, params, referenceData, getWorker]);

  return { result, progress };
}
