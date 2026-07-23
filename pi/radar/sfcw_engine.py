"""Stepped-Frequency Continuous Wave (SFCW) radar engine.

Orchestrates the bladeRF to sweep through discrete frequency steps,
capture IQ at each, and compute range profiles via IFFT.

Uses dual-channel reference: TX1+RX1 for antenna signal, TX2+RX2 as
phase reference (short cable loopback). Dividing signal by reference
eliminates random PLL phase offsets between TX and RX synthesizers.
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
CALIBRATION_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'calibration')


class SFCWEngine:
    def __init__(self, driver: BladeRFDriver):
        self.driver = driver
        self.start_freq = 1_000_000_000
        self.stop_freq = 6_000_000_000
        self.step_size = 10_000_000
        self.settle_time = 0.003
        self.num_buffers = 4
        self.tx1_gain = 30
        self.rx1_gain = 30
        self.tx2_gain = 30
        self.rx2_gain = 20
        self.rx_gain_min = 5
        self.rx_gain_max = 38
        self.range_offset = 0.55
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
        self._sub_mode = None  # 'background' | 'reference' | None
        self._cal_mode = None
        # Hardware calibration data (loaded from disk)
        self._cal_cable_thru = None
        self._cal_free_space = None
        self._cal_cable_thru_enabled = False  # disabled — causes ringing artifacts
        self._load_hw_calibration()
        # Running mean subtraction state
        self._mean_accumulator = None
        self._mean_count = 0
        self._mean_subtraction_enabled = False

    def _load_hw_calibration(self):
        """Load hardware calibration files from disk if they exist."""
        for mode, attr in [('cable_thru', '_cal_cable_thru'), ('free_space', '_cal_free_space')]:
            filepath = os.path.join(CALIBRATION_DIR, f'{mode}.npz')
            if os.path.exists(filepath):
                try:
                    npz = np.load(filepath, allow_pickle=True)
                    setattr(self, attr, {
                        'frequencies': npz['frequencies'],
                        'h_complex': npz['h_complex'],
                    })
                    print(f"[sfcw] Loaded {mode} calibration ({len(npz['frequencies'])} points)")
                except Exception as e:
                    print(f"[sfcw] Failed to load {mode} calibration: {e}")
                    setattr(self, attr, None)

    def _interpolate_cal(self, cal_data, target_freqs):
        """Interpolate stored calibration H(f) onto the current sweep's frequency grid."""
        cal_freqs = cal_data['frequencies']
        cal_h = cal_data['h_complex']
        cal_mag = np.abs(cal_h)
        cal_phase = np.unwrap(np.angle(cal_h))
        mag_interp = np.interp(target_freqs, cal_freqs, cal_mag)
        phase_interp = np.interp(target_freqs, cal_freqs, cal_phase)
        return mag_interp * np.exp(1j * phase_interp)

    def _aligned_subtraction(self, h_current, h_reference, freqs, step_size):
        """Subtract reference after aligning to the dominant reflector (wall).

        Estimates the complex transfer function between current and reference
        by fitting a linear phase model + amplitude scaling to their ratio.
        This corrects for both range shift (phase slope) and gain variation
        (amplitude change) between the two measurements.
        """
        n = len(h_current)

        # Compute the ratio — encodes the difference between the two scans
        ref_mag = np.abs(h_reference)
        valid = ref_mag > np.max(ref_mag) * 0.01
        ratio = np.ones(n, dtype=np.complex128)
        ratio[valid] = h_current[valid] / h_reference[valid]

        # Weight by reference magnitude (trust high-SNR bins more)
        weights = ref_mag / (np.max(ref_mag) + 1e-12)
        indices = np.arange(n, dtype=np.float64)

        # Extract phase of ratio and unwrap
        phase_ratio = np.unwrap(np.angle(ratio))

        # Weighted linear regression on phase: phase = slope * index + intercept
        w = weights
        sum_w = np.sum(w)
        if sum_w < 1e-12:
            return h_current - h_reference, h_reference

        mean_x = np.sum(w * indices) / sum_w
        mean_y = np.sum(w * phase_ratio) / sum_w
        cov_xy = np.sum(w * (indices - mean_x) * (phase_ratio - mean_y))
        var_x = np.sum(w * (indices - mean_x)**2)

        if var_x < 1e-12:
            return h_current - h_reference, h_reference

        slope = cov_xy / var_x
        intercept = mean_y - slope * mean_x

        # Amplitude scaling: weighted mean of |ratio| gives the gain factor
        ratio_mag = np.abs(ratio)
        amp_scale = np.sum(w * ratio_mag) / sum_w

        # Apply phase correction + amplitude scaling to reference
        correction = amp_scale * np.exp(1j * (slope * indices + intercept))
        h_ref_aligned = h_reference * correction

        return h_current - h_ref_aligned, h_ref_aligned

    @property
    def num_steps(self):
        return int((self.stop_freq - self.start_freq) / self.step_size) + 1

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

    def set_params(self, **kwargs):
        with self._lock:
            if 'start_freq' in kwargs:
                self.start_freq = int(kwargs['start_freq'])
            if 'stop_freq' in kwargs:
                self.stop_freq = int(kwargs['stop_freq'])
            if 'step_size' in kwargs:
                self.step_size = int(kwargs['step_size'])
            if 'settle_time' in kwargs:
                self.settle_time = float(kwargs['settle_time'])
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
            if 'rx_gain_min' in kwargs:
                self.rx_gain_min = int(kwargs['rx_gain_min'])
            if 'rx_gain_max' in kwargs:
                self.rx_gain_max = int(kwargs['rx_gain_max'])
            if 'range_offset' in kwargs:
                self.range_offset = float(kwargs['range_offset'])

    def get_params(self):
        return {
            'start_freq': self.start_freq,
            'stop_freq': self.stop_freq,
            'step_size': self.step_size,
            'settle_time': self.settle_time,
            'num_buffers': self.num_buffers,
            'tx1_gain': self.tx1_gain,
            'rx1_gain': self.rx1_gain,
            'tx2_gain': self.tx2_gain,
            'rx2_gain': self.rx2_gain,
            'rx_gain_min': self.rx_gain_min,
            'rx_gain_max': self.rx_gain_max,
            'range_offset': self.range_offset,
            'num_steps': self.num_steps,
            'bandwidth': self.bandwidth,
            'range_resolution': self.range_resolution,
            'max_range': self.max_range,
            'background_active': self._background is not None,
            'reference_active': self._reference is not None,
            'sub_mode': self._sub_mode,
            'mean_subtraction': self._mean_subtraction_enabled,
            'mean_count': self._mean_count,
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

    def enable_mean_subtraction(self):
        self._mean_subtraction_enabled = True
        self._mean_accumulator = None
        self._mean_count = 0

    def disable_mean_subtraction(self):
        self._mean_subtraction_enabled = False

    def reset_mean(self):
        self._mean_accumulator = None
        self._mean_count = 0

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
                range_profile = self._perform_sweep()
                if range_profile is not None and self._callback:
                    self._callback(range_profile)
                if self._single_shot:
                    break

        except Exception as e:
            print(f"[sfcw] Sweep error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
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

        # Apply gains AFTER modules are enabled (enable_module resets gain state)
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

    def _rx_capture(self, rx1_iq, rx2_iq):
        self._rx_latest = (rx1_iq, rx2_iq)
        self._rx_event.set()

    def _perform_sweep(self):
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step = self.step_size
            settle = self.settle_time
            num_buffers = self.num_buffers

        num_steps = int((stop - start) / step) + 1
        freqs = np.linspace(start, stop, num_steps).astype(np.int64)
        h_signal = np.zeros(num_steps, dtype=np.complex128)
        h_reference = np.zeros(num_steps, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        rx_ch1 = bladerf.CHANNEL_RX(1)

        # Dynamic RX gain ramp: compensates AD9361 output power rolloff at higher
        # frequencies. Both RX1 and RX2 get identical gain at each step so any
        # gain-dependent phase offset cancels in the h_signal/h_reference division.
        freq_norm = (freqs - freqs[0]) / max(float(freqs[-1] - freqs[0]), 1)
        rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        for i in range(num_steps):
            if self._stop_event.is_set():
                return None

            f = int(freqs[i])
            g = int(rx_gains[i])
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, f)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, f)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, g)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, g)
            time.sleep(settle)

            # Discard first buffer — may contain samples from before PLL settled
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

        # Phase-reference division: cancels TX and RX PLL phase offsets
        ref_mag = np.abs(h_reference)
        valid = ref_mag > 1e-10
        h_cal = np.zeros(num_steps, dtype=np.complex128)
        h_cal[valid] = h_signal[valid] / h_reference[valid]

        # Hardware calibration corrections (disabled — causes ringing/artifacts)
        # if self._cal_cable_thru_enabled and self._cal_cable_thru is not None:
        #     ct = self._interpolate_cal(self._cal_cable_thru, freqs)
        #     ct_mag = np.abs(ct)
        #     noise_floor = np.max(ct_mag) * 0.05
        #     regularizer = ct_mag**2 / (ct_mag**2 + noise_floor**2)
        #     ct_safe = np.where(ct_mag > 1e-10, ct, 1.0)
        #     h_cal = h_cal / ct_safe * regularizer
        #
        # if self._cal_free_space is not None:
        #     fs = self._interpolate_cal(self._cal_free_space, freqs)
        #     if self._cal_cable_thru_enabled and self._cal_cable_thru is not None:
        #         fs = fs / ct_safe * regularizer
        #     h_cal = h_cal - fs

        # Running mean subtraction (disabled — not suitable for B-scan movement)
        # if self._mean_subtraction_enabled:
        #     if self._mean_accumulator is None or len(self._mean_accumulator) != num_steps:
        #         self._mean_accumulator = h_cal.copy()
        #         self._mean_count = 1
        #     else:
        #         self._mean_count += 1
        #         alpha = 1.0 / self._mean_count
        #         self._mean_accumulator = (1 - alpha) * self._mean_accumulator + alpha * h_cal
        #     h_cal = h_cal - self._mean_accumulator

        # Capture reference (wall-aligned subtraction)
        if self._capture_reference:
            self._reference = h_cal.copy()
            self._capture_reference = False
            self._background = None
            self._sub_mode = 'reference'

        # Capture background (static subtraction)
        if self._capture_background:
            self._background = h_cal.copy()
            self._capture_background = False
            self._reference = None
            self._sub_mode = 'background'

        # Apply whichever subtraction mode is active
        ref_trace_db = None
        cur_trace_db = None
        mag_subtraction = False

        if self._sub_mode == 'background' and self._background is not None and len(self._background) == num_steps:
            h_cal = h_cal - self._background
        elif self._sub_mode == 'reference' and self._reference is not None and len(self._reference) == num_steps:
            mag_subtraction = True
            h_original = h_cal.copy()
            _, h_ref_aligned = self._aligned_subtraction(h_cal, self._reference, freqs, step)

        # Phase coherence diagnostics
        phase_raw = np.angle(h_cal)
        phase_unwrapped = np.unwrap(phase_raw)
        coeffs = np.polyfit(np.arange(num_steps), phase_unwrapped, 1)
        residuals = phase_unwrapped - np.polyval(coeffs, np.arange(num_steps))
        phase_std = float(np.std(residuals))

        window = np.hanning(num_steps)
        half = num_steps // 2
        max_range = SPEED_OF_LIGHT / (2 * step)
        distances = np.linspace(0, max_range, num_steps) - self.range_offset

        if mag_subtraction:
            # Magnitude-domain subtraction: |current| - |reference| in dB
            cur_profile = np.abs(np.fft.ifft(h_original * window))
            ref_profile = np.abs(np.fft.ifft(h_ref_aligned * window))
            cur_db = 20 * np.log10(cur_profile + 1e-12)
            ref_db = 20 * np.log10(ref_profile + 1e-12)
            magnitude_db = cur_db - ref_db
            cur_trace_db = cur_db[:half].tolist()
            ref_trace_db = ref_db[:half].tolist()
        else:
            range_profile = np.fft.ifft(h_cal * window)
            magnitude_db = 20 * np.log10(np.abs(range_profile) + 1e-12)

        magnitude_db = magnitude_db[:half]
        distances = distances[:half]

        # Clip to positive distances only
        positive_mask = distances >= 0
        magnitude_db = magnitude_db[positive_mask]
        distances = distances[positive_mask]
        if ref_trace_db is not None:
            ref_trace_db = [ref_trace_db[i] for i, m in enumerate(positive_mask) if m]
            cur_trace_db = [cur_trace_db[i] for i, m in enumerate(positive_mask) if m]

        result = {
            'type': 'range_profile',
            'distances': distances.tolist(),
            'magnitudes': magnitude_db.tolist(),
            'range_resolution': SPEED_OF_LIGHT / (2 * (stop - start)),
            'max_range': max_range / 2,
            'num_steps': num_steps,
            'timestamp': time.time(),
            'phase_coherence': {
                'phase_std_rad': phase_std,
                'phase_std_deg': float(np.degrees(phase_std)),
                'coherent': phase_std < 0.3,
                'slope_rad_per_step': float(coeffs[0]),
            },
            'h_cal_real': h_cal.real.tolist(),
            'h_cal_imag': h_cal.imag.tolist(),
            'freqs': freqs.tolist(),
        }

        if ref_trace_db is not None:
            result['ref_trace'] = ref_trace_db
            result['cur_trace'] = cur_trace_db

        return result

    # ------------------------------------------------------------------
    # Hardware calibration
    # ------------------------------------------------------------------

    def run_calibration(self, mode, callback):
        """Run a calibration sweep. mode: 'cable_thru', 'free_space', 'per_position'.

        Stops any running sweep first, then performs a single sweep collecting
        raw complex data. Results are passed to callback and saved to disk.
        """
        if self.running:
            self.stop()
        self._callback = callback
        self._stop_event.clear()
        self._single_shot = True
        self._cal_mode = mode
        self.running = True
        self._thread = threading.Thread(target=self._calibration_loop, daemon=True)
        self._thread.start()

    def _calibration_loop(self):
        try:
            self._configure_hardware_for_cal()
            self._start_tx_rx_for_cal()

            result = self._perform_calibration_sweep()
            if result is not None and self._callback:
                self._callback(result)

        except Exception as e:
            print(f"[sfcw] Calibration error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.running = False
            self._cal_mode = None

    def _configure_hardware_for_cal(self):
        mode = self._cal_mode
        if mode == 'cable_thru':
            # Fixed gains for cable-through calibration
            self.driver.tx_gain = 20
            self.driver.rx_gain = 20
            self.driver.tx2_gain = 20
            self.driver.rx2_gain = 20
        else:
            # free_space / per_position use current params
            self.driver.tx_gain = self.tx1_gain
            self.driver.rx_gain = self.rx1_gain
            self.driver.tx2_gain = self.tx2_gain
            self.driver.rx2_gain = self.rx2_gain
        self.driver.set_waveform('cw', offset=100_000, amplitude=0.9)
        self.driver._configure_channels_dual()

    def _start_tx_rx_for_cal(self):
        mode = self._cal_mode
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

        if mode == 'cable_thru':
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), 20)
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(1), 20)
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), 20)
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(1), 20)
        else:
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), int(self.rx1_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(1), int(self.rx2_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), int(self.tx1_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(1), int(self.tx2_gain))

    def _perform_calibration_sweep(self):
        """Perform a single sweep collecting raw complex data for calibration."""
        mode = self._cal_mode

        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step = self.step_size
            settle = self.settle_time
            num_buffers = self.num_buffers

        num_steps = int((stop - start) / step) + 1
        freqs = np.linspace(start, stop, num_steps).astype(np.int64)
        h_signal = np.zeros(num_steps, dtype=np.complex128)
        h_reference = np.zeros(num_steps, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        rx_ch1 = bladerf.CHANNEL_RX(1)

        # Gain ramp: cable_thru uses fixed gain, others use dynamic ramp
        if mode == 'cable_thru':
            rx_gains = np.full(num_steps, 20, dtype=int)
        else:
            freq_norm = (freqs - freqs[0]) / max(float(freqs[-1] - freqs[0]), 1)
            rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        for i in range(num_steps):
            if self._stop_event.is_set():
                return None

            f = int(freqs[i])
            g = int(rx_gains[i])
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, f)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, f)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, g)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, g)
            time.sleep(settle)

            # Discard first buffer
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

        # Phase-reference division (no background subtraction, no windowing/IFFT)
        ref_mag = np.abs(h_reference)
        valid = ref_mag > 1e-10
        h_cal = np.zeros(num_steps, dtype=np.complex128)
        h_cal[valid] = h_signal[valid] / h_reference[valid]

        timestamp = time.time()

        return {
            'type': 'calibration_raw',
            'mode': mode,
            'frequencies': freqs,
            'h_complex': h_cal,
            'h_signal_raw': h_signal,
            'h_reference_raw': h_reference,
            'timestamp': timestamp,
        }

    def save_calibration(self, mode, data, step_size_cm=None):
        """Save calibration data to .npz file.

        Args:
            mode: 'cable_thru', 'free_space', or 'per_position'
            data: dict from _perform_calibration_sweep
            step_size_cm: spatial step size (per_position only)
        """
        os.makedirs(CALIBRATION_DIR, exist_ok=True)

        params = {
            'start_freq': self.start_freq,
            'stop_freq': self.stop_freq,
            'step_size': self.step_size,
            'settle_time': self.settle_time,
            'num_buffers': self.num_buffers,
            'tx1_gain': self.tx1_gain if mode != 'cable_thru' else 20,
            'rx1_gain': self.rx1_gain if mode != 'cable_thru' else 20,
            'tx2_gain': self.tx2_gain if mode != 'cable_thru' else 20,
            'rx2_gain': self.rx2_gain if mode != 'cable_thru' else 20,
            'rx_gain_min': self.rx_gain_min,
            'rx_gain_max': self.rx_gain_max,
            'mode': mode,
        }

        filepath = os.path.join(CALIBRATION_DIR, f'{mode}.npz')

        if mode == 'per_position':
            # Append to existing file or create new
            existing = self._load_per_position_data()
            if existing is not None:
                h_complex_list = np.vstack([existing['h_complex'], data['h_complex'][np.newaxis, :]])
                h_signal_list = np.vstack([existing['h_signal_raw'], data['h_signal_raw'][np.newaxis, :]])
                h_reference_list = np.vstack([existing['h_reference_raw'], data['h_reference_raw'][np.newaxis, :]])
                timestamps = np.append(existing['timestamp'], data['timestamp'])
            else:
                h_complex_list = data['h_complex'][np.newaxis, :]
                h_signal_list = data['h_signal_raw'][np.newaxis, :]
                h_reference_list = data['h_reference_raw'][np.newaxis, :]
                timestamps = np.array([data['timestamp']])

            save_kwargs = {
                'frequencies': data['frequencies'],
                'h_complex': h_complex_list,
                'h_signal_raw': h_signal_list,
                'h_reference_raw': h_reference_list,
                'params': json.dumps(params),
                'timestamp': timestamps,
            }
            if step_size_cm is not None:
                save_kwargs['step_size_cm'] = np.array(step_size_cm)
            np.savez(filepath, **save_kwargs)
        else:
            np.savez(filepath,
                     frequencies=data['frequencies'],
                     h_complex=data['h_complex'],
                     h_signal_raw=data['h_signal_raw'],
                     h_reference_raw=data['h_reference_raw'],
                     params=json.dumps(params),
                     timestamp=np.array(data['timestamp']))

        print(f"[sfcw] Calibration saved: {filepath}")
        self._load_hw_calibration()

    def _load_per_position_data(self):
        """Load existing per_position.npz data, or return None."""
        filepath = os.path.join(CALIBRATION_DIR, 'per_position.npz')
        if not os.path.exists(filepath):
            return None
        try:
            npz = np.load(filepath, allow_pickle=True)
            return {
                'h_complex': npz['h_complex'],
                'h_signal_raw': npz['h_signal_raw'],
                'h_reference_raw': npz['h_reference_raw'],
                'timestamp': npz['timestamp'],
            }
        except Exception as e:
            print(f"[sfcw] Error loading per_position data: {e}")
            return None

    def load_calibration_status(self):
        """Check which calibration files exist and return status dict."""
        status = {
            'cable_thru': None,
            'free_space': None,
            'per_position': None,
        }

        for mode in ['cable_thru', 'free_space']:
            filepath = os.path.join(CALIBRATION_DIR, f'{mode}.npz')
            if os.path.exists(filepath):
                try:
                    npz = np.load(filepath, allow_pickle=True)
                    ts = float(npz['timestamp'])
                    status[mode] = {'timestamp': ts}
                except Exception:
                    pass

        filepath = os.path.join(CALIBRATION_DIR, 'per_position.npz')
        if os.path.exists(filepath):
            try:
                npz = np.load(filepath, allow_pickle=True)
                h = npz['h_complex']
                count = h.shape[0] if h.ndim == 2 else 1
                step_size_cm = float(npz['step_size_cm']) if 'step_size_cm' in npz else None
                status['per_position'] = {
                    'count': count,
                    'step_size_cm': step_size_cm,
                }
            except Exception:
                pass

        return status

    def clear_per_position(self):
        """Reset per-position calibration (delete file)."""
        filepath = os.path.join(CALIBRATION_DIR, 'per_position.npz')
        if os.path.exists(filepath):
            os.remove(filepath)
            print("[sfcw] Per-position calibration cleared")

    def undo_per_position(self):
        """Remove last position from per-position calibration."""
        filepath = os.path.join(CALIBRATION_DIR, 'per_position.npz')
        if not os.path.exists(filepath):
            return

        try:
            npz = np.load(filepath, allow_pickle=True)
            h_complex = npz['h_complex']
            if h_complex.ndim < 2 or h_complex.shape[0] <= 1:
                # Only one position, just delete the file
                os.remove(filepath)
                print("[sfcw] Per-position calibration cleared (was single position)")
                return

            # Remove last row
            save_kwargs = {
                'frequencies': npz['frequencies'],
                'h_complex': h_complex[:-1],
                'h_signal_raw': npz['h_signal_raw'][:-1],
                'h_reference_raw': npz['h_reference_raw'][:-1],
                'params': str(npz['params']),
                'timestamp': npz['timestamp'][:-1],
            }
            if 'step_size_cm' in npz:
                save_kwargs['step_size_cm'] = npz['step_size_cm']
            np.savez(filepath, **save_kwargs)
            print(f"[sfcw] Per-position calibration: removed last position ({h_complex.shape[0] - 1} remaining)")
        except Exception as e:
            print(f"[sfcw] Error undoing per-position: {e}")
