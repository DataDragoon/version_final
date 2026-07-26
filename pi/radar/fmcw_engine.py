"""Synthetic Bandwidth FMCW radar engine.

Uses stepped-frequency CW processing with dual-channel reference division.
Mathematically equivalent to SFCW for our hardware parameters (15 MHz
instantaneous BW, sub-3m targets) but kept as a separate engine with
independently tunable parameters for experimentation.

Architecture:
  - TX1+TX2 transmit CW tone (100 kHz offset)
  - LO steps through N center frequencies to cover the full band
  - RX1 captures scene reflections, RX2 captures cable-through reference
  - H(f) = mean(RX1 × conj(ref_tone)) / mean(RX2 × conj(ref_tone))
  - IFFT of H(f) → range profile
"""

import json
import os
import threading
import time
import numpy as np

from bladerf_driver import BladeRFDriver
from bladerf._bladerf import libbladeRF, ffi
import bladerf

SPEED_OF_LIGHT = 299_792_458


class FMCWEngine:
    def __init__(self, driver: BladeRFDriver):
        self.driver = driver
        self.start_freq = 1_000_000_000
        self.stop_freq = 6_000_000_000
        self.step_size = 10_000_000
        self.pll_settle_time = 0.001
        self.num_buffers = 2
        self.tx1_gain = 30
        self.rx1_gain = 30
        self.tx2_gain = 30
        self.rx2_gain = 20
        self.range_offset = 0.55
        # State
        self.running = False
        self._stop_event = threading.Event()
        self._thread = None
        self._callback = None
        self._lock = threading.Lock()
        self._single_shot = False
        self._background = None
        self._capture_background = False
        self._reference = None
        self._capture_reference = False
        self._sub_mode = None

    @property
    def bandwidth(self):
        return self.stop_freq - self.start_freq

    @property
    def range_resolution(self):
        if self.bandwidth == 0:
            return float('inf')
        return SPEED_OF_LIGHT / (2 * self.bandwidth)

    @property
    def max_range(self):
        if self.step_size == 0:
            return float('inf')
        return SPEED_OF_LIGHT / (2 * self.step_size)

    @property
    def num_steps(self):
        return int((self.stop_freq - self.start_freq) / self.step_size) + 1

    def set_params(self, **kwargs):
        with self._lock:
            if 'start_freq' in kwargs:
                self.start_freq = int(kwargs['start_freq'])
            if 'stop_freq' in kwargs:
                self.stop_freq = int(kwargs['stop_freq'])
            if 'step_size' in kwargs:
                self.step_size = int(kwargs['step_size'])
            if 'pll_settle_time' in kwargs:
                self.pll_settle_time = float(kwargs['pll_settle_time'])
            if 'num_buffers' in kwargs:
                self.num_buffers = max(1, int(kwargs['num_buffers']))
            if 'tx1_gain' in kwargs:
                self.tx1_gain = int(kwargs['tx1_gain'])
            if 'rx1_gain' in kwargs:
                self.rx1_gain = int(kwargs['rx1_gain'])
            if 'tx2_gain' in kwargs:
                self.tx2_gain = int(kwargs['tx2_gain'])
            if 'rx2_gain' in kwargs:
                self.rx2_gain = int(kwargs['rx2_gain'])
            if 'range_offset' in kwargs:
                self.range_offset = float(kwargs['range_offset'])

    def get_params(self):
        return {
            'start_freq': self.start_freq,
            'stop_freq': self.stop_freq,
            'step_size': self.step_size,
            'pll_settle_time': self.pll_settle_time,
            'num_buffers': self.num_buffers,
            'tx1_gain': self.tx1_gain,
            'rx1_gain': self.rx1_gain,
            'tx2_gain': self.tx2_gain,
            'rx2_gain': self.rx2_gain,
            'range_offset': self.range_offset,
            'num_steps': self.num_steps,
            'bandwidth': self.bandwidth,
            'range_resolution': self.range_resolution,
            'max_range': self.max_range,
            'background_active': self._background is not None,
            'reference_active': self._reference is not None,
            'sub_mode': self._sub_mode,
        }

    def capture_background(self):
        self._capture_background = True

    def clear_background(self):
        self._background = None
        self._capture_background = False
        self._sub_mode = None

    def capture_reference(self):
        self._capture_reference = True

    def clear_reference(self):
        self._reference = None
        self._capture_reference = False
        self._sub_mode = None

    def clear_all_subtraction(self):
        self._background = None
        self._capture_background = False
        self._reference = None
        self._capture_reference = False
        self._sub_mode = None

    def start(self, callback):
        if self.running:
            return
        self._callback = callback
        self._stop_event.clear()
        self._single_shot = False
        self.running = True
        self._thread = threading.Thread(target=self._sweep_loop, daemon=True)
        self._thread.start()

    def run_single(self, callback):
        if self.running:
            self.stop()
        self._callback = callback
        self._stop_event.clear()
        self._single_shot = True
        self.running = True
        self._thread = threading.Thread(target=self._sweep_loop, daemon=True)
        self._thread.start()

    def stop(self):
        if not self.running:
            return
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        self.running = False

    def _sweep_loop(self):
        try:
            self._configure_hardware()
            self._start_tx_rx()

            while not self._stop_event.is_set():
                result = self._perform_sweep()
                if result is not None and self._callback:
                    self._callback(result)
                if self._single_shot:
                    break

        except Exception as e:
            print(f"[fmcw] Sweep error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self._restore_hardware()
            self.running = False

    def _configure_hardware(self):
        self.driver.tx_gain = self.tx1_gain
        self.driver.rx_gain = self.rx1_gain
        self.driver.tx2_gain = self.tx2_gain
        self.driver.rx2_gain = self.rx2_gain
        self.driver.set_waveform('cw', offset=100_000, amplitude=0.9)
        self.driver._configure_channels_dual()

    def _start_tx_rx(self):
        self._rx_latest = (None, None)
        self._rx_event = threading.Event()
        n = 1024
        t = np.arange(n, dtype=np.float64) / self.driver.sample_rate
        self._ref_tone = np.exp(-1j * 2 * np.pi * self.driver.cw_offset * t)
        self.driver.start_tx_dual()
        self.driver.start_rx_dual(self._rx_capture, num_samples=n)
        time.sleep(0.05)

        dev_ptr = self.driver.device.dev[0]
        libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(0), libbladeRF.BLADERF_GAIN_MGC)
        libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(1), libbladeRF.BLADERF_GAIN_MGC)
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), int(self.rx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(1), int(self.rx2_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), int(self.tx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(1), int(self.tx2_gain))

    def _stop_tx_rx(self):
        self.driver.stop_rx_dual()
        self.driver.stop_tx_dual()

    def _restore_hardware(self):
        """Restore driver to RF Calib defaults (2 MSPS, CW waveform)."""
        try:
            self.driver.sample_rate = 2_000_000
            self.driver.bandwidth = 1_500_000
            self.driver.waveform_type = 'cw'
            dev_ptr = self.driver.device.dev[0]
            tx_ch = bladerf.CHANNEL_TX(0)
            rx_ch = bladerf.CHANNEL_RX(0)
            libbladeRF.bladerf_set_sample_rate(dev_ptr, tx_ch, 2_000_000, ffi.NULL)
            libbladeRF.bladerf_set_sample_rate(dev_ptr, rx_ch, 2_000_000, ffi.NULL)
            libbladeRF.bladerf_set_bandwidth(dev_ptr, tx_ch, 1_500_000, ffi.NULL)
            libbladeRF.bladerf_set_bandwidth(dev_ptr, rx_ch, 1_500_000, ffi.NULL)
            self.driver._tx_buffer = self.driver._generate(int(self.driver.sample_rate * 0.01))
            print("[fmcw] Hardware restored to RF Calib defaults (2 MSPS, CW)")
        except Exception as e:
            print(f"[fmcw] Warning: failed to restore hardware: {e}")

    def _rx_capture(self, rx1_iq, rx2_iq):
        self._rx_latest = (rx1_iq, rx2_iq)
        self._rx_event.set()

    def _perform_sweep(self):
        """Stepped CW sweep with dual-channel reference division."""
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step_size = self.step_size

        num_steps = int((stop - start) / step_size) + 1
        freqs = np.linspace(start, stop, num_steps).astype(np.int64)
        h_signal = np.zeros(num_steps, dtype=np.complex128)
        h_reference = np.zeros(num_steps, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)

        settle = self.pll_settle_time
        num_buffers = self.num_buffers

        for i in range(num_steps):
            if self._stop_event.is_set():
                return None

            f = int(freqs[i])
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, f)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, f)
            time.sleep(settle)

            # Discard first buffer (stale from previous frequency)
            self._rx_event.clear()
            self._rx_event.wait(timeout=1.0)

            sig_accum = 0j
            ref_accum = 0j
            captured = 0
            for _ in range(num_buffers):
                self._rx_event.clear()
                if not self._rx_event.wait(timeout=1.0):
                    break

                rx1, rx2 = self._rx_latest
                if rx1 is None or rx2 is None:
                    continue

                i1 = rx1[0::2].astype(np.float64) / 2047.0
                q1 = rx1[1::2].astype(np.float64) / 2047.0
                sig_accum += np.mean((i1 + 1j * q1) * self._ref_tone)

                i2 = rx2[0::2].astype(np.float64) / 2047.0
                q2 = rx2[1::2].astype(np.float64) / 2047.0
                ref_accum += np.mean((i2 + 1j * q2) * self._ref_tone)

                captured += 1

            h_signal[i] = sig_accum / max(captured, 1)
            h_reference[i] = ref_accum / max(captured, 1)

            if self._callback and i % 10 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_steps,
                    'freq_mhz': freqs[i] / 1e6,
                })

        # Phase-reference division
        ref_mag = np.abs(h_reference)
        valid = ref_mag > 1e-10
        h_cal = np.zeros(num_steps, dtype=np.complex128)
        h_cal[valid] = h_signal[valid] / h_reference[valid]

        # Capture reference / background
        if self._capture_reference:
            self._reference = h_cal.copy()
            self._capture_reference = False
            self._background = None
            self._sub_mode = 'reference'

        if self._capture_background:
            self._background = h_cal.copy()
            self._capture_background = False
            self._reference = None
            self._sub_mode = 'background'

        # Apply subtraction
        if self._sub_mode == 'background' and self._background is not None and len(self._background) == len(h_cal):
            h_cal = h_cal - self._background
        elif self._sub_mode == 'reference' and self._reference is not None and len(self._reference) == len(h_cal):
            h_cal = h_cal - self._reference

        # Range profile via IFFT
        window = np.hanning(num_steps)
        range_profile = np.fft.ifft(h_cal * window)
        magnitude_db = 20 * np.log10(np.abs(range_profile) + 1e-12)

        half = num_steps // 2
        max_range = SPEED_OF_LIGHT / (2 * step_size)
        distances = np.linspace(0, max_range, num_steps) - self.range_offset

        magnitude_db = magnitude_db[:half]
        distances = distances[:half]

        positive_mask = distances >= 0
        magnitude_db = magnitude_db[positive_mask]
        distances = distances[positive_mask]

        return {
            'type': 'range_profile',
            'distances': distances.tolist(),
            'magnitudes': magnitude_db.tolist(),
            'range_resolution': SPEED_OF_LIGHT / (2 * (stop - start)),
            'max_range': max_range / 2,
            'num_steps': num_steps,
            'timestamp': time.time(),
            'h_cal_real': h_cal.real.tolist(),
            'h_cal_imag': h_cal.imag.tolist(),
            'freqs': freqs.tolist(),
        }
