"""Synthetic Bandwidth FMCW radar engine.

Generates wideband chirps in sub-bands (each within the bladeRF's 56 MHz
instantaneous bandwidth), de-chirps against the TX2→RX2 cable reference,
applies phase-stitching correction at sub-band boundaries, and produces
a range profile equivalent to the full synthetic bandwidth SFCW sweep
but ~5x faster.

Architecture:
  - TX1+TX2 transmit identical chirps (baseband -BW/2 to +BW/2)
  - LO steps through N center frequencies to cover the full band
  - RX1 captures scene reflections, RX2 captures cable-through reference
  - De-chirp: RX1 × conj(RX2) per sub-band → beat signal
  - Stitch: phase-correct boundaries using cable reference
  - IFFT of stitched spectrum → range profile
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


class FMCWEngine:
    def __init__(self, driver: BladeRFDriver):
        self.driver = driver
        # Sweep parameters (same interface as SFCW for interchangeability)
        self.start_freq = 1_000_000_000
        self.stop_freq = 6_000_000_000
        # FMCW-specific parameters
        self.sub_band_bw = 20_000_000       # 20 MHz per chirp (safe for MIMO 30.72 MSPS)
        self.chirp_duration = 50e-6         # 50 μs per chirp
        self.pll_settle_time = 0.002        # 2 ms PLL settling between sub-bands
        self.num_chirps_avg = 4             # chirps to average per sub-band
        self.overlap_fraction = 0.25        # 25% overlap for correlation stitching
        # Reference channel mode: False = single-channel with overlap stitching (default)
        self.use_reference_channel = False
        # Gain parameters
        self.tx1_gain = 30
        self.rx1_gain = 30
        self.tx2_gain = 30
        self.rx2_gain = 20
        self.rx_gain_min = 5
        self.rx_gain_max = 38
        self.range_offset = 0.55
        # Discard buffers after PLL hop (extra buffers beyond the mandatory 1)
        self.discard_buffers = 0
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
        self._mean_accumulator = None
        self._mean_count = 0
        self._mean_subtraction_enabled = False
        # Channel calibration: differential transfer function between RX paths
        self._channel_cal = None
        self._channel_cal_file = os.path.join(CALIBRATION_DIR, 'fmcw_channel_cal.npz')

    @property
    def effective_sub_band_step(self):
        """Frequency step between adjacent sub-band centers."""
        return int(self.sub_band_bw * (1.0 - self.overlap_fraction))

    @property
    def num_sub_bands(self):
        total_bw = self.stop_freq - self.start_freq
        step = self.effective_sub_band_step
        return int(np.ceil(total_bw / step))

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
        # For synthetic bandwidth FMCW, max range is set by the frequency
        # resolution within each sub-band (1/chirp_duration)
        freq_res = 1.0 / self.chirp_duration
        return SPEED_OF_LIGHT / (2 * freq_res)

    @property
    def num_steps(self):
        """Equivalent number of frequency points in the stitched spectrum."""
        samples_per_chirp = int(self.chirp_duration * self.driver.sample_rate)
        return self.num_sub_bands * samples_per_chirp

    def set_params(self, **kwargs):
        with self._lock:
            if 'start_freq' in kwargs:
                self.start_freq = int(kwargs['start_freq'])
            if 'stop_freq' in kwargs:
                self.stop_freq = int(kwargs['stop_freq'])
            if 'sub_band_bw' in kwargs:
                self.sub_band_bw = int(kwargs['sub_band_bw'])
            if 'chirp_duration' in kwargs:
                self.chirp_duration = float(kwargs['chirp_duration'])
            if 'pll_settle_time' in kwargs:
                self.pll_settle_time = float(kwargs['pll_settle_time'])
            if 'num_chirps_avg' in kwargs:
                self.num_chirps_avg = max(1, int(kwargs['num_chirps_avg']))
            if 'overlap_fraction' in kwargs:
                self.overlap_fraction = max(0.0, min(0.5, float(kwargs['overlap_fraction'])))
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
            if 'discard_buffers' in kwargs:
                self.discard_buffers = max(0, int(kwargs['discard_buffers']))
            if 'use_reference_channel' in kwargs:
                self.use_reference_channel = bool(kwargs['use_reference_channel'])

    def get_params(self):
        return {
            'start_freq': self.start_freq,
            'stop_freq': self.stop_freq,
            'sub_band_bw': self.sub_band_bw,
            'chirp_duration': self.chirp_duration,
            'pll_settle_time': self.pll_settle_time,
            'num_chirps_avg': self.num_chirps_avg,
            'overlap_fraction': self.overlap_fraction,
            'tx1_gain': self.tx1_gain,
            'rx1_gain': self.rx1_gain,
            'tx2_gain': self.tx2_gain,
            'rx2_gain': self.rx2_gain,
            'rx_gain_min': self.rx_gain_min,
            'rx_gain_max': self.rx_gain_max,
            'range_offset': self.range_offset,
            'num_sub_bands': self.num_sub_bands,
            'bandwidth': self.bandwidth,
            'range_resolution': self.range_resolution,
            'max_range': self.max_range,
            'background_active': self._background is not None,
            'reference_active': self._reference is not None,
            'sub_mode': self._sub_mode,
            'mean_subtraction': self._mean_subtraction_enabled,
            'mean_count': self._mean_count,
            'use_reference_channel': self.use_reference_channel,
            'channel_cal_loaded': self.has_channel_cal(),
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

    def load_channel_cal(self):
        """Load saved channel calibration from disk if available."""
        if os.path.exists(self._channel_cal_file):
            try:
                data = np.load(self._channel_cal_file)
                self._channel_cal = data['cal']
                print(f"[fmcw] Channel calibration loaded ({len(self._channel_cal)} points)")
            except Exception as e:
                print(f"[fmcw] Failed to load channel cal: {e}")
                self._channel_cal = None

    def save_channel_cal(self, cal_data):
        """Save channel calibration to disk."""
        os.makedirs(os.path.dirname(self._channel_cal_file), exist_ok=True)
        np.savez(self._channel_cal_file, cal=cal_data)
        self._channel_cal = cal_data
        print(f"[fmcw] Channel calibration saved ({len(cal_data)} points)")

    def clear_channel_cal(self):
        self._channel_cal = None
        if os.path.exists(self._channel_cal_file):
            os.remove(self._channel_cal_file)
            print("[fmcw] Channel calibration cleared")

    def has_channel_cal(self):
        return self._channel_cal is not None

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
                result = self._perform_fmcw_sweep()
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
            self.running = False

    def _configure_hardware(self):
        self.driver.tx_gain = self.tx1_gain
        self.driver.rx_gain = self.rx1_gain

        required_rate = int(self.sub_band_bw * 1.25)  # 25% margin over chirp BW

        if self.use_reference_channel:
            # Dual-channel: TX1+TX2, RX1+RX2 — limited to 30.72 MSPS per channel
            self.driver.tx2_gain = self.tx2_gain
            self.driver.rx2_gain = self.rx2_gain
            max_rate = 30_720_000
            fmcw_rate = min(required_rate, max_rate)
            fmcw_rate = max(fmcw_rate, 4_000_000)
            self.driver.sample_rate = fmcw_rate
            self.driver.bandwidth = int(fmcw_rate * 0.8)
            self.driver._configure_channels_dual()
            mode_str = "dual-channel (reference)"
        else:
            # Single-channel: TX1+RX1 only — can go up to 61.44 MSPS
            max_rate = 61_440_000
            fmcw_rate = min(required_rate, max_rate)
            fmcw_rate = max(fmcw_rate, 4_000_000)
            self.driver.sample_rate = fmcw_rate
            self.driver.bandwidth = int(fmcw_rate * 0.8)
            self._configure_single_channel()
            mode_str = "single-channel (overlap stitch)"

        self._fmcw_sample_rate = fmcw_rate
        total_msps = fmcw_rate * (4 if self.use_reference_channel else 2) / 1e6
        print(f"[fmcw] {mode_str}: {fmcw_rate/1e6:.2f} MSPS, {total_msps:.0f} MSPS total USB throughput")

    def _configure_single_channel(self):
        """Configure TX0 + RX0 only for single-channel FMCW."""
        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, int(self.driver.center_freq))
        libbladeRF.bladerf_set_sample_rate(dev_ptr, tx_ch, int(self.driver.sample_rate), ffi.NULL)
        libbladeRF.bladerf_set_bandwidth(dev_ptr, tx_ch, int(self.driver.bandwidth), ffi.NULL)
        libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, int(self.driver.center_freq))
        libbladeRF.bladerf_set_sample_rate(dev_ptr, rx_ch, int(self.driver.sample_rate), ffi.NULL)
        libbladeRF.bladerf_set_bandwidth(dev_ptr, rx_ch, int(self.driver.bandwidth), ffi.NULL)
        libbladeRF.bladerf_set_gain_mode(dev_ptr, rx_ch, libbladeRF.BLADERF_GAIN_MGC)
        libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, int(self.rx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, tx_ch, int(self.tx1_gain))
        print(f"[bladerf] Single-channel configured: TX1={self.tx1_gain}dB RX1={self.rx1_gain}dB")

    def _start_tx_rx(self):
        self._rx_latest = (None, None)
        self._rx_event = threading.Event()
        samples_per_chirp = int(self.chirp_duration * self.driver.sample_rate)
        self._chirp_samples = max(1024, samples_per_chirp)

        self.driver.set_waveform('chirp',
                                 chirp_bw=self.sub_band_bw,
                                 chirp_duration=self.chirp_duration,
                                 amplitude=0.9)

        if self.use_reference_channel:
            self.driver.start_tx_dual()
            self.driver.start_rx_dual(self._rx_capture_dual, num_samples=self._chirp_samples)
            time.sleep(0.05)
            dev_ptr = self.driver.device.dev[0]
            libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(0), libbladeRF.BLADERF_GAIN_MGC)
            libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(1), libbladeRF.BLADERF_GAIN_MGC)
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), int(self.rx1_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(1), int(self.rx2_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), int(self.tx1_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(1), int(self.tx2_gain))
        else:
            # Capture 3× chirp length so we can reliably find chirp boundary
            rx_samples = self._chirp_samples * 3
            self.driver.start_tx()
            self.driver.start_rx(self._rx_capture_single, num_samples=rx_samples)
            time.sleep(0.05)
            dev_ptr = self.driver.device.dev[0]
            libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(0), libbladeRF.BLADERF_GAIN_MGC)
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), int(self.rx1_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), int(self.tx1_gain))

    def _stop_tx_rx(self):
        if self.use_reference_channel:
            self.driver.stop_rx_dual()
            self.driver.stop_tx_dual()
        else:
            self.driver.stop_rx()
            self.driver.stop_tx()

    def _rx_capture_dual(self, rx1_iq, rx2_iq):
        self._rx_latest = (rx1_iq, rx2_iq)
        self._rx_event.set()

    def _rx_capture_single(self, iq):
        self._rx_latest = (iq, None)
        self._rx_event.set()

    def _generate_chirp_iq(self, num_samples):
        """Generate baseband linear chirp from -BW/2 to +BW/2."""
        sample_rate = getattr(self, '_fmcw_sample_rate', self.driver.sample_rate)
        t = np.arange(num_samples, dtype=np.float64) / sample_rate
        f0 = -self.sub_band_bw / 2
        f1 = self.sub_band_bw / 2
        # Linear FM: phase = 2π(f0·t + (f1-f0)/(2T)·t²)
        sweep_rate = (f1 - f0) / self.chirp_duration
        phase = 2 * np.pi * (f0 * t + 0.5 * sweep_rate * t * t)
        return np.exp(1j * phase)

    def _perform_fmcw_sweep(self):
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            sub_bw = self.sub_band_bw
            chirp_dur = self.chirp_duration
            num_avg = self.num_chirps_avg
            overlap = self.overlap_fraction
            pll_settle = self.pll_settle_time

        # Use unified capture (handles both single and dual channel)
        beat_signal, _, spc, num_sub = self._capture_single_sweep()
        if beat_signal is None:
            return None

        # For dual-channel mode, apply boundary stitching (single-channel already stitched)
        if self.use_reference_channel:
            for i in range(1, num_sub):
                boundary = i * spc
                if boundary >= len(beat_signal):
                    break
                phi_prev = np.angle(beat_signal[boundary - 1])
                phi_curr = np.angle(beat_signal[boundary])
                phi_err = (phi_curr - phi_prev + np.pi) % (2 * np.pi) - np.pi
                beat_signal[boundary:] *= np.exp(-1j * phi_err)

        h_cal = beat_signal

        total_points = len(h_cal)
        freqs = np.linspace(start, stop, total_points)

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

        # --- Range profile via IFFT ---
        window = np.hanning(len(h_cal))
        range_profile = np.fft.ifft(h_cal * window)
        magnitude_db = 20 * np.log10(np.abs(range_profile) + 1e-12)

        # Distance axis
        total_bw = stop - start
        max_range = SPEED_OF_LIGHT / (2 * (total_bw / total_points))
        distances = np.linspace(0, max_range, total_points) - self.range_offset

        # Take first half (positive ranges)
        half = total_points // 2
        magnitude_db = magnitude_db[:half]
        distances = distances[:half]

        positive_mask = distances >= 0
        magnitude_db = magnitude_db[positive_mask]
        distances = distances[positive_mask]

        # Phase coherence diagnostics (use subset for fitting to avoid slowness)
        phase_raw = np.angle(h_cal)
        phase_unwrapped = np.unwrap(phase_raw)
        subset_step = max(1, len(phase_unwrapped) // 1000)
        indices_sub = np.arange(0, len(phase_unwrapped), subset_step)
        phase_sub = phase_unwrapped[indices_sub]
        coeffs = np.polyfit(indices_sub, phase_sub, 1)
        residuals = phase_sub - np.polyval(coeffs, indices_sub)
        phase_std = float(np.std(residuals))

        # Downsample h_cal/freqs for transport — target ~500 points like SFCW
        # SAR/seepage workers need consistent length across positions
        transport_step = max(1, total_points // 500)
        h_cal_transport = h_cal[::transport_step]
        freqs_transport = freqs[::transport_step]

        result = {
            'type': 'range_profile',
            'distances': distances.tolist(),
            'magnitudes': magnitude_db.tolist(),
            'range_resolution': SPEED_OF_LIGHT / (2 * total_bw),
            'max_range': max_range / 2,
            'num_steps': total_points,
            'num_sub_bands': num_sub,
            'timestamp': time.time(),
            'sweep_time': num_sub * (chirp_dur * num_avg + pll_settle),
            'phase_coherence': {
                'phase_std_rad': phase_std,
                'phase_std_deg': float(np.degrees(phase_std)),
                'coherent': phase_std < 0.3,
                'slope_rad_per_step': float(coeffs[0]),
            },
            'h_cal_real': h_cal_transport.real.tolist(),
            'h_cal_imag': h_cal_transport.imag.tolist(),
            'freqs': freqs_transport.tolist(),
        }

        return result

    # ------------------------------------------------------------------
    # FMCW Validation Tests (run via hardware calib panel)
    # ------------------------------------------------------------------

    def run_validation_test(self, test_type, callback):
        """Run an FMCW validation test.

        test_type: 'linearity', 'stitching', 'repeatability', 'phase_residual'
        """
        if self.running:
            self.stop()
        self._callback = callback
        self._stop_event.clear()
        self._single_shot = True
        self.running = True
        self._thread = threading.Thread(
            target=self._validation_test_loop,
            args=(test_type,),
            daemon=True
        )
        self._thread.start()

    def _validation_test_loop(self, test_type):
        # Channel cal requires dual-channel mode
        saved_mode = self.use_reference_channel
        if test_type == 'channel_cal':
            self.use_reference_channel = True
        try:
            print(f"[fmcw] Starting validation test: {test_type}")
            self._configure_hardware()
            self._start_tx_rx()
            print(f"[fmcw] Hardware configured, TX/RX started. Running {test_type}...")

            if test_type == 'linearity':
                result = self._test_linearity()
            elif test_type == 'stitching':
                result = self._test_stitching()
            elif test_type == 'repeatability':
                result = self._test_repeatability()
            elif test_type == 'phase_residual':
                result = self._test_phase_residual()
            elif test_type == 'channel_cal':
                result = self._calibrate_channels()
            elif test_type == 'parametric_linearity':
                result = self._test_parametric_linearity()
            else:
                result = {'error': f'Unknown test type: {test_type}'}

            if result is not None and self._callback:
                print(f"[fmcw] Test {test_type} complete: {'PASS' if result.get('pass') else 'FAIL'}")
                self._callback(result)

        except Exception as e:
            import traceback
            print(f"[fmcw] Validation test error: {e}")
            traceback.print_exc()
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.use_reference_channel = saved_mode
            self.running = False

    def _capture_single_sweep(self):
        """Perform one complete FMCW sweep.

        Dual-channel mode: de-chirp via RX1*conj(RX2), timing offset cancels.
        Single-channel mode: de-chirp via RX1*conj(chirp_ref), use overlap for stitching.

        Returns: (beat_signal, ref_phase, samples_per_chirp, num_sub)
        """
        if self.use_reference_channel:
            return self._capture_sweep_dual()
        else:
            return self._capture_sweep_single()

    def _capture_sweep_dual(self):
        """Dual-channel sweep: RX1*conj(RX2) de-chirp."""
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            sub_bw = self.sub_band_bw
            chirp_dur = self.chirp_duration
            pll_settle = self.pll_settle_time
            num_avg = self.num_chirps_avg
            overlap = self.overlap_fraction

        sub_step = int(sub_bw * (1.0 - overlap))
        num_sub = int(np.ceil((stop - start) / sub_step))
        samples_per_chirp = int(chirp_dur * self.driver.sample_rate)

        beat_signal = np.zeros(num_sub * samples_per_chirp, dtype=np.complex128)
        ref_phase = np.zeros(num_sub, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        rx_ch1 = bladerf.CHANNEL_RX(1)

        center_freqs = np.array([start + sub_bw // 2 + i * sub_step for i in range(num_sub)])
        freq_norm = (center_freqs - center_freqs[0]) / max(float(center_freqs[-1] - center_freqs[0]), 1)
        rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        for i in range(num_sub):
            if self._stop_event.is_set():
                return None, None, None, None

            center = int(center_freqs[i])
            g = int(rx_gains[i])
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, center)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, center)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, g)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, g)
            time.sleep(pll_settle)

            for _ in range(1 + self.discard_buffers):
                self._rx_event.clear()
                self._rx_event.wait(timeout=1.0)

            sig_accum = np.zeros(samples_per_chirp, dtype=np.complex128)
            ref_accum = np.zeros(samples_per_chirp, dtype=np.complex128)
            captured = 0

            for _ in range(num_avg):
                self._rx_event.clear()
                if not self._rx_event.wait(timeout=1.0):
                    break
                rx1, rx2 = self._rx_latest
                if rx1 is None or rx2 is None:
                    continue
                i1 = rx1[0::2].astype(np.float64) / 2047.0
                q1 = rx1[1::2].astype(np.float64) / 2047.0
                i2 = rx2[0::2].astype(np.float64) / 2047.0
                q2 = rx2[1::2].astype(np.float64) / 2047.0
                n_rx = min(len(i1), samples_per_chirp)
                sig_accum[:n_rx] += (i1[:n_rx] + 1j * q1[:n_rx])
                ref_accum[:n_rx] += (i2[:n_rx] + 1j * q2[:n_rx])
                captured += 1

            if captured > 0:
                sig_accum /= captured
                ref_accum /= captured

            idx_start = i * samples_per_chirp
            idx_end = idx_start + samples_per_chirp
            beat_signal[idx_start:idx_end] = sig_accum * np.conj(ref_accum)
            ref_phase[i] = ref_accum[samples_per_chirp // 2]

            if self._callback and i % 5 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_sub,
                    'freq_mhz': center / 1e6,
                })

        if self._channel_cal is not None and len(self._channel_cal) == len(beat_signal):
            cal_mag = np.abs(self._channel_cal)
            valid = cal_mag > np.max(cal_mag) * 0.01
            beat_signal[valid] /= self._channel_cal[valid]

        return beat_signal, ref_phase, samples_per_chirp, num_sub

    def _find_chirp_wrap(self, rx_iq, samples_per_chirp):
        """Find the chirp wrap point in raw RX signal.

        The TX chirp loops, sweeping from -BW/2 to +BW/2 then wrapping back to -BW/2.
        This wrap creates a large negative spike in the second derivative of phase
        (instantaneous frequency drops by BW in one sample). Detect this spike to
        find where the chirp restarts.

        With 3× capture, we search the middle portion (skip first 10% of a chirp
        for unwrap warmup, ensure samples_per_chirp remains after the found wrap).

        Returns the sample index right after the wrap (start of a new chirp cycle).
        """
        n_rx = len(rx_iq)

        # Compute instantaneous frequency (phase derivative)
        phase = np.unwrap(np.angle(rx_iq))
        inst_freq = np.diff(phase)

        # Second derivative: ~constant during linear chirp sweep, large negative at wrap
        freq_accel = np.diff(inst_freq)

        # Skip early samples where unwrap has no context
        search_start = max(10, samples_per_chirp // 10)
        # Ensure we can extract a full chirp after the wrap
        search_end = min(len(freq_accel), n_rx - samples_per_chirp - 2)
        if search_end <= search_start:
            return 0

        # The wrap causes a spike of approximately -2π × BW / sample_rate
        # For 20 MHz BW at 25 MSPS: spike ≈ -5.0 rad
        region = freq_accel[search_start:search_end]
        min_idx = int(np.argmin(region))
        spike_val = region[min_idx]

        # Validate: threshold at -0.5 rad (normal acceleration is ~0.004 rad)
        if spike_val > -0.5:
            return 0

        wrap_idx = search_start + min_idx + 2
        return wrap_idx

    def _capture_sweep_single(self):
        """Single-channel sweep with overlap correlation stitching.

        De-chirps RX1 against locally-generated chirp. TX loops chirp continuously;
        we capture 2× chirp duration and cross-correlate to find alignment before
        de-chirping. Adjacent sub-bands overlap in frequency — the overlapping beat
        content correlates to find the relative phase offset between hops.
        """
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            sub_bw = self.sub_band_bw
            chirp_dur = self.chirp_duration
            pll_settle = self.pll_settle_time
            num_avg = self.num_chirps_avg
            overlap = self.overlap_fraction

        # Enforce minimum overlap for correlation
        if overlap < 0.1:
            overlap = 0.25

        sub_step = int(sub_bw * (1.0 - overlap))
        num_sub = int(np.ceil((stop - start) / sub_step))
        samples_per_chirp = int(chirp_dur * self.driver.sample_rate)
        overlap_samples = int(samples_per_chirp * overlap)

        chirp_ref = self._generate_chirp_iq(samples_per_chirp)

        beat_segments = []

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)

        center_freqs = np.array([start + sub_bw // 2 + i * sub_step for i in range(num_sub)])
        freq_norm = (center_freqs - center_freqs[0]) / max(float(center_freqs[-1] - center_freqs[0]), 1)
        rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        for i in range(num_sub):
            if self._stop_event.is_set():
                return None, None, None, None

            center = int(center_freqs[i])
            g = int(rx_gains[i])
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, center)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, center)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, g)
            time.sleep(pll_settle)

            for _ in range(1 + self.discard_buffers):
                self._rx_event.clear()
                self._rx_event.wait(timeout=1.0)

            beat_accum = np.zeros(samples_per_chirp, dtype=np.complex128)
            captured = 0

            for _ in range(num_avg):
                self._rx_event.clear()
                if not self._rx_event.wait(timeout=1.0):
                    break
                rx1, _ = self._rx_latest
                if rx1 is None:
                    continue
                i1 = rx1[0::2].astype(np.float64) / 2047.0
                q1 = rx1[1::2].astype(np.float64) / 2047.0
                rx_iq = i1 + 1j * q1

                # Find chirp wrap in raw signal and extract one aligned period
                wrap_idx = self._find_chirp_wrap(rx_iq, samples_per_chirp)
                end_idx = wrap_idx + samples_per_chirp
                if end_idx <= len(rx_iq):
                    aligned = rx_iq[wrap_idx:end_idx]
                else:
                    aligned = rx_iq[:samples_per_chirp]

                # De-chirp against aligned reference
                beat = aligned * np.conj(chirp_ref)
                beat_accum += beat
                captured += 1

            if captured > 0:
                beat_accum /= captured

            beat_segments.append(beat_accum)

            if self._callback and i % 5 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_sub,
                    'freq_mhz': center / 1e6,
                })

        # --- Overlap correlation stitching ---
        # Each sub-band still has a constant phase offset (PLL lands at random phase).
        # The overlap region between adjacent sub-bands covers the same frequencies,
        # so their beat signals should match up to a phase offset.
        # Output: non-overlapping portion of each sub-band, uniformly spaced.
        non_overlap = samples_per_chirp - overlap_samples

        # Phase-correct all segments relative to segment 0
        for i in range(1, num_sub):
            prev_overlap = beat_segments[i - 1][-overlap_samples:]
            curr_overlap = beat_segments[i][:overlap_samples]

            corr = np.sum(curr_overlap * np.conj(prev_overlap))
            if np.abs(corr) > 0:
                phase_offset = np.exp(-1j * np.angle(corr))
            else:
                phase_offset = 1.0

            beat_segments[i] = beat_segments[i] * phase_offset

        # Concatenate non-overlapping portions (uniform spc for all sub-bands)
        stitched = np.concatenate([seg[:non_overlap] for seg in beat_segments])

        ref_phase = np.zeros(num_sub, dtype=np.complex128)

        return stitched, ref_phase, non_overlap, num_sub

    def _test_linearity(self):
        """Test chirp linearity via cable-through.

        With RX1*conj(RX2) de-chirp, a cable-through setup (same chirp on both
        paths) should produce a near-DC beat per sub-band — any differential path
        length gives a constant beat frequency. Deviation from linear phase within
        each sub-band = chirp non-linearity or filter distortion.
        """
        beat_signal, ref_phase, spc, num_sub = self._capture_single_sweep()
        if beat_signal is None:
            return None

        linearity_results = []
        for i in range(num_sub):
            segment = beat_signal[i * spc:(i + 1) * spc]
            phase = np.unwrap(np.angle(segment))
            t = np.arange(spc, dtype=np.float64)
            coeffs = np.polyfit(t, phase, 1)
            residual = phase - np.polyval(coeffs, t)
            rms_err = float(np.sqrt(np.mean(residual**2)))
            peak_err = float(np.max(np.abs(residual)))
            linearity_results.append({
                'sub_band': i,
                'rms_phase_err_rad': round(rms_err, 6),
                'rms_phase_err_deg': round(np.degrees(rms_err), 4),
                'peak_phase_err_rad': round(peak_err, 6),
                'peak_phase_err_deg': round(np.degrees(peak_err), 4),
                'beat_freq_hz': round(float(coeffs[0]) * self.driver.sample_rate / (2 * np.pi), 2),
            })

        overall_rms = np.mean([r['rms_phase_err_deg'] for r in linearity_results])
        overall_peak = np.max([r['peak_phase_err_deg'] for r in linearity_results])

        return {
            'type': 'fmcw_test_result',
            'test': 'linearity',
            'pass': overall_rms < 5.0,
            'overall_rms_deg': round(overall_rms, 4),
            'overall_peak_deg': round(overall_peak, 4),
            'threshold_deg': 5.0,
            'per_sub_band': linearity_results,
            'description': 'Chirp linearity test via cable reference. Measures residual phase after linear fit. <5° RMS = good.',
            'timestamp': time.time(),
        }

    def _test_stitching(self):
        """Test sub-band stitching quality.

        With beat_signal = RX1*conj(RX2), phase jumps at sub-band boundaries
        in beat_signal directly reveal PLL settling errors. We measure before/after
        correction and compute PSLR from the range profile.
        """
        beat_signal, ref_phase, spc, num_sub = self._capture_single_sweep()
        if beat_signal is None:
            return None

        # Measure boundary phase jumps BEFORE correction
        jumps_before = []
        for i in range(1, num_sub):
            boundary = i * spc
            phi_prev = np.angle(beat_signal[boundary - 1])
            phi_curr = np.angle(beat_signal[boundary])
            jump = (phi_curr - phi_prev + np.pi) % (2 * np.pi) - np.pi
            jumps_before.append(float(jump))

        # Apply stitching correction using beat_signal boundaries directly
        beat_corrected = beat_signal.copy()
        for i in range(1, num_sub):
            boundary = i * spc
            phi_prev = np.angle(beat_corrected[boundary - 1])
            phi_curr = np.angle(beat_corrected[boundary])
            phi_err = (phi_curr - phi_prev + np.pi) % (2 * np.pi) - np.pi
            beat_corrected[boundary:] *= np.exp(-1j * phi_err)

        # Measure boundary phase jumps AFTER correction
        jumps_after = []
        for i in range(1, num_sub):
            boundary = i * spc
            phi_prev = np.angle(beat_corrected[boundary - 1])
            phi_curr = np.angle(beat_corrected[boundary])
            jump = (phi_curr - phi_prev + np.pi) % (2 * np.pi) - np.pi
            jumps_after.append(float(jump))

        # Range profile (cable-through → single peak expected)
        window = np.hanning(len(beat_corrected))
        profile = np.abs(np.fft.ifft(beat_corrected * window))
        profile_db = 20 * np.log10(profile / (np.max(profile) + 1e-12) + 1e-12)

        peak_idx = np.argmax(profile)

        # PSLR: highest sidelobe relative to main peak (exclude ±5 bins)
        mask = np.ones(len(profile_db), dtype=bool)
        mask[max(0, peak_idx - 5):min(len(mask), peak_idx + 6)] = False
        pslr = float(np.max(profile_db[mask])) if np.any(mask) else -100.0

        # Main lobe -3dB width
        half_profile = profile_db[:len(profile_db) // 2]
        above_3db = np.where(half_profile > -3.0)[0]
        lobe_width_bins = int(above_3db[-1] - above_3db[0]) if len(above_3db) > 1 else 1

        rms_before = float(np.sqrt(np.mean(np.array(jumps_before)**2)))
        rms_after = float(np.sqrt(np.mean(np.array(jumps_after)**2)))

        return {
            'type': 'fmcw_test_result',
            'test': 'stitching',
            'pass': rms_after < np.radians(3.0) and pslr < -20.0,
            'boundary_jumps_before_rad': [round(j, 4) for j in jumps_before],
            'boundary_jumps_after_rad': [round(j, 4) for j in jumps_after],
            'rms_jump_before_deg': round(np.degrees(rms_before), 4),
            'rms_jump_after_deg': round(np.degrees(rms_after), 4),
            'pslr_db': round(pslr, 2),
            'main_lobe_width_bins': lobe_width_bins,
            'range_profile_db': profile_db[:len(profile_db) // 2:max(1, len(profile_db) // 500)].tolist(),
            'description': 'Stitching test: phase jumps at sub-band boundaries before/after correction. PSLR <-20dB and RMS jump <3° = good.',
            'timestamp': time.time(),
        }

    def _test_repeatability(self):
        """Test sweep-to-sweep repeatability.

        Runs two back-to-back sweeps, applies boundary stitching to each,
        then compares. Non-deterministic PLL settling → low repeatability.
        """
        beat_sig1, _, spc, num_sub = self._capture_single_sweep()
        if beat_sig1 is None:
            return None

        # Apply stitching to first sweep
        for i in range(1, num_sub):
            boundary = i * spc
            phi_err = np.angle(beat_sig1[boundary]) - np.angle(beat_sig1[boundary - 1])
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            beat_sig1[boundary:] *= np.exp(-1j * phi_err)

        # Second sweep
        beat_sig2, _, _, _ = self._capture_single_sweep()
        if beat_sig2 is None:
            return None

        for i in range(1, num_sub):
            boundary = i * spc
            phi_err = np.angle(beat_sig2[boundary]) - np.angle(beat_sig2[boundary - 1])
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            beat_sig2[boundary:] *= np.exp(-1j * phi_err)

        # Range profiles
        window = np.hanning(len(beat_sig1))
        p1 = np.fft.ifft(beat_sig1 * window)
        p2 = np.fft.ifft(beat_sig2 * window)

        # Correlation
        correlation = float(np.abs(np.vdot(p1, p2))**2 / (np.vdot(p1, p1) * np.vdot(p2, p2)).real)

        # Residual difference in dB
        diff = np.abs(p1) - np.abs(p2)
        peak = max(np.max(np.abs(p1)), np.max(np.abs(p2)))
        residual_db = 20 * np.log10(np.sqrt(np.mean(diff**2)) / (peak + 1e-12) + 1e-12)

        return {
            'type': 'fmcw_test_result',
            'test': 'repeatability',
            'pass': correlation > 0.99 and residual_db < -40,
            'correlation': round(correlation, 6),
            'residual_db': round(float(residual_db), 2),
            'threshold_correlation': 0.99,
            'threshold_residual_db': -40,
            'description': 'Sweep repeatability: correlation >0.99 and residual <-40dB = good stitching.',
            'timestamp': time.time(),
        }

    def _test_phase_residual(self):
        """Measure phase residual across stitched bandwidth on cable reference.

        With beat_signal = RX1*conj(RX2), on a cable-through the beat phase should
        be linear (constant differential delay). After boundary stitching, any
        deviation from linear = residual system errors.
        """
        beat_signal, ref_phase, spc, num_sub = self._capture_single_sweep()
        if beat_signal is None:
            return None

        # Apply boundary stitching
        for i in range(1, num_sub):
            boundary = i * spc
            phi_err = np.angle(beat_signal[boundary]) - np.angle(beat_signal[boundary - 1])
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            beat_signal[boundary:] *= np.exp(-1j * phi_err)

        # Full phase across stitched bandwidth
        phase = np.unwrap(np.angle(beat_signal))
        indices = np.arange(len(phase), dtype=np.float64)

        # Linear fit (subsample for speed)
        subset_step = max(1, len(phase) // 2000)
        idx_sub = indices[::subset_step]
        phase_sub = phase[::subset_step]
        coeffs = np.polyfit(idx_sub, phase_sub, 1)
        residual_full = phase - np.polyval(coeffs, indices)

        rms_residual = float(np.sqrt(np.mean(residual_full**2)))
        peak_residual = float(np.max(np.abs(residual_full)))

        # Downsample residual for transport
        step = max(1, len(residual_full) // 500)
        residual_plot = residual_full[::step]

        # Estimate cable delay from phase slope
        total_bw = self.stop_freq - self.start_freq
        total_points = num_sub * spc
        freq_per_sample = total_bw / total_points
        cable_delay_ns = float(coeffs[0] / (2 * np.pi * freq_per_sample) * 1e9)

        return {
            'type': 'fmcw_test_result',
            'test': 'phase_residual',
            'pass': rms_residual < np.radians(5.0),
            'rms_residual_rad': round(rms_residual, 6),
            'rms_residual_deg': round(np.degrees(rms_residual), 4),
            'peak_residual_rad': round(peak_residual, 6),
            'peak_residual_deg': round(np.degrees(peak_residual), 4),
            'estimated_cable_delay_ns': round(cable_delay_ns, 3),
            'phase_slope_rad_per_sample': round(float(coeffs[0]), 8),
            'residual_plot': [round(float(r), 4) for r in residual_plot.tolist()],
            'description': 'Phase residual across full stitched bandwidth. Cable should give linear phase; deviation = system errors. <5° RMS = good.',
            'timestamp': time.time(),
        }

    def _calibrate_channels(self):
        """Capture differential channel transfer function for calibration.

        With identical cables on both channels, RX1*conj(RX2) should be flat
        (unit magnitude, zero phase). Any deviation is the differential analog
        filter response between channels. We store this and divide it out of
        future sweeps.
        """
        # Average multiple sweeps for a clean calibration
        num_cal_sweeps = 4
        cal_accum = None

        for sweep_idx in range(num_cal_sweeps):
            if self._callback:
                self._callback({
                    'type': 'progress',
                    'step': sweep_idx,
                    'total': num_cal_sweeps,
                    'freq_mhz': 0,
                })

            beat_signal, _, spc, num_sub = self._capture_single_sweep()
            if beat_signal is None:
                return None

            # Stitch boundaries
            for i in range(1, num_sub):
                boundary = i * spc
                phi_err = np.angle(beat_signal[boundary]) - np.angle(beat_signal[boundary - 1])
                phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
                beat_signal[boundary:] *= np.exp(-1j * phi_err)

            if cal_accum is None:
                cal_accum = beat_signal.copy()
            else:
                cal_accum += beat_signal

        cal_accum /= num_cal_sweeps

        # Normalize: we want the phase slope (cable delay) preserved,
        # but amplitude variation captured. Remove the mean phase slope
        # so calibration only corrects per-sample amplitude/phase ripple.
        phase = np.unwrap(np.angle(cal_accum))
        indices = np.arange(len(phase), dtype=np.float64)
        coeffs = np.polyfit(indices[::10], phase[::10], 1)
        # Remove linear component (cable delay) — keep only ripple
        cal_normalized = cal_accum * np.exp(-1j * np.polyval(coeffs, indices))

        self.save_channel_cal(cal_normalized)

        # Compute stats for reporting
        mag_db = 20 * np.log10(np.abs(cal_normalized) + 1e-12)
        phase_deg = np.degrees(np.angle(cal_normalized))

        return {
            'type': 'fmcw_test_result',
            'test': 'channel_cal',
            'pass': True,
            'mag_ripple_db': round(float(np.max(mag_db) - np.min(mag_db)), 2),
            'phase_ripple_deg': round(float(np.max(phase_deg) - np.min(phase_deg)), 2),
            'mag_std_db': round(float(np.std(mag_db)), 4),
            'num_points': len(cal_normalized),
            'num_sweeps_averaged': num_cal_sweeps,
            'description': 'Channel calibration captured. Differential transfer function stored — will be applied to all future sweeps.',
            'timestamp': time.time(),
        }

    def _test_parametric_linearity(self):
        """Sweep through multiple parameter combinations and measure linearity.

        Tests settle times and discard buffer counts to find the best config.
        """
        settle_times = [0.001, 0.002, 0.003, 0.005, 0.008]
        discard_counts = [0, 1, 2]
        avg_counts = [4, 8]

        results = []
        total_configs = len(settle_times) * len(discard_counts) * len(avg_counts)
        config_idx = 0

        original_settle = self.pll_settle_time
        original_discard = self.discard_buffers
        original_avg = self.num_chirps_avg

        for settle in settle_times:
            for discard in discard_counts:
                for avg in avg_counts:
                    if self._stop_event.is_set():
                        break

                    self.pll_settle_time = settle
                    self.discard_buffers = discard
                    self.num_chirps_avg = avg

                    if self._callback:
                        self._callback({
                            'type': 'progress',
                            'step': config_idx,
                            'total': total_configs,
                            'freq_mhz': settle * 1000,
                        })

                    beat_signal, _, spc, num_sub = self._capture_single_sweep()
                    if beat_signal is None:
                        continue

                    # Measure per-sub-band linearity
                    rms_errors = []
                    for i in range(num_sub):
                        segment = beat_signal[i * spc:(i + 1) * spc]
                        phase = np.unwrap(np.angle(segment))
                        t = np.arange(spc, dtype=np.float64)
                        coeffs = np.polyfit(t, phase, 1)
                        residual = phase - np.polyval(coeffs, t)
                        rms_errors.append(float(np.degrees(np.sqrt(np.mean(residual**2)))))

                    overall_rms = np.mean(rms_errors)
                    peak_sub = np.max(rms_errors)

                    results.append({
                        'settle_ms': round(settle * 1000, 1),
                        'discard': discard,
                        'avg': avg,
                        'rms_deg': round(overall_rms, 2),
                        'peak_sub_deg': round(peak_sub, 2),
                    })
                    config_idx += 1

        # Restore original params
        self.pll_settle_time = original_settle
        self.discard_buffers = original_discard
        self.num_chirps_avg = original_avg

        # Sort by RMS to find best config
        results.sort(key=lambda x: x['rms_deg'])
        best = results[0] if results else None

        return {
            'type': 'fmcw_test_result',
            'test': 'parametric_linearity',
            'pass': best is not None and best['rms_deg'] < 10.0,
            'best_config': best,
            'all_results': results,
            'description': 'Parametric sweep of settle time, discard buffers, and averaging. Find the config that minimizes phase error.',
            'timestamp': time.time(),
        }
