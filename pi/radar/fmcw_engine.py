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
        self.sub_band_bw = 56_000_000       # 56 MHz per chirp (bladeRF max)
        self.chirp_duration = 50e-6         # 50 μs per chirp
        self.pll_settle_time = 0.002        # 2 ms PLL settling between sub-bands
        self.num_chirps_avg = 4             # chirps to average per sub-band
        self.overlap_fraction = 0.0         # 0 = no overlap, 0.1 = 10% overlap
        # Gain parameters
        self.tx1_gain = 30
        self.rx1_gain = 30
        self.tx2_gain = 30
        self.rx2_gain = 20
        self.rx_gain_min = 5
        self.rx_gain_max = 38
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
        self._mean_accumulator = None
        self._mean_count = 0
        self._mean_subtraction_enabled = False

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
        self.driver.tx2_gain = self.tx2_gain
        self.driver.rx2_gain = self.rx2_gain
        self.driver._configure_channels_dual()

    def _start_tx_rx(self):
        self._rx_latest = (None, None)
        self._rx_event = threading.Event()
        samples_per_chirp = int(self.chirp_duration * self.driver.sample_rate)
        self._chirp_samples = max(1024, samples_per_chirp)

        # Configure chirp waveform and start TX FIRST (same as SFCW)
        # RX sync_rx blocks waiting for samples — TX must already be running
        self.driver.set_waveform('chirp',
                                 chirp_bw=self.sub_band_bw,
                                 chirp_duration=self.chirp_duration,
                                 amplitude=0.9)
        self.driver.start_tx_dual()
        self.driver.start_rx_dual(self._rx_capture, num_samples=self._chirp_samples)
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

    def _rx_capture(self, rx1_iq, rx2_iq):
        self._rx_latest = (rx1_iq, rx2_iq)
        self._rx_event.set()

    def _generate_chirp_iq(self, num_samples):
        """Generate baseband linear chirp from -BW/2 to +BW/2."""
        t = np.arange(num_samples, dtype=np.float64) / self.driver.sample_rate
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
            pll_settle = self.pll_settle_time
            num_avg = self.num_chirps_avg
            overlap = self.overlap_fraction

        sub_step = int(sub_bw * (1.0 - overlap))
        num_sub = int(np.ceil((stop - start) / sub_step))
        samples_per_chirp = int(chirp_dur * self.driver.sample_rate)

        # Generate the baseband chirp reference (same for all sub-bands)
        chirp_ref = self._generate_chirp_iq(samples_per_chirp)

        # Storage for de-chirped beat signals per sub-band
        beat_signal = np.zeros(num_sub * samples_per_chirp, dtype=np.complex128)
        beat_ref = np.zeros(num_sub * samples_per_chirp, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        rx_ch1 = bladerf.CHANNEL_RX(1)

        # Dynamic RX gain ramp across sub-bands (same logic as SFCW)
        center_freqs = np.array([start + sub_bw // 2 + i * sub_step for i in range(num_sub)])
        freq_norm = (center_freqs - center_freqs[0]) / max(float(center_freqs[-1] - center_freqs[0]), 1)
        rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        for i in range(num_sub):
            if self._stop_event.is_set():
                return None

            center = int(center_freqs[i])
            g = int(rx_gains[i])

            # Retune LO to sub-band center
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, center)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, center)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, g)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, g)

            # Wait for PLL to settle
            time.sleep(pll_settle)

            # Discard first buffer (PLL transient)
            self._rx_event.clear()
            self._rx_event.wait(timeout=1.0)

            # Collect and average multiple chirps
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

                # Convert to complex float
                i1 = rx1[0::2].astype(np.float64) / 2047.0
                q1 = rx1[1::2].astype(np.float64) / 2047.0
                rx1_complex = i1 + 1j * q1

                i2 = rx2[0::2].astype(np.float64) / 2047.0
                q2 = rx2[1::2].astype(np.float64) / 2047.0
                rx2_complex = i2 + 1j * q2

                # Trim or pad to chirp length
                n_rx = min(len(rx1_complex), samples_per_chirp)
                sig_accum[:n_rx] += rx1_complex[:n_rx]
                ref_accum[:n_rx] += rx2_complex[:n_rx]
                captured += 1

            if captured > 0:
                sig_accum /= captured
                ref_accum /= captured

            # De-chirp: multiply received signal by conjugate of reference chirp
            # This is the digital equivalent of analog stretch processing
            beat_scene = sig_accum * np.conj(chirp_ref[:samples_per_chirp])
            beat_cable = ref_accum * np.conj(chirp_ref[:samples_per_chirp])

            # Store in the full stitched array
            idx_start = i * samples_per_chirp
            idx_end = idx_start + samples_per_chirp
            beat_signal[idx_start:idx_end] = beat_scene
            beat_ref[idx_start:idx_end] = beat_cable

            # Progress callback
            if self._callback and i % 5 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_sub,
                    'freq_mhz': center / 1e6,
                })

        # --- Phase stitching correction using cable reference ---
        # The cable reference has known, constant delay. Any phase discontinuity
        # at sub-band boundaries in the reference is purely system error.
        for i in range(1, num_sub):
            boundary = i * samples_per_chirp
            # Phase at end of previous sub-band's reference beat
            phi_prev = np.angle(beat_ref[boundary - 1])
            # Phase at start of current sub-band's reference beat
            phi_curr = np.angle(beat_ref[boundary])
            # The error is any jump that the cable reference shows
            phi_err = phi_curr - phi_prev
            # Apply correction to both signal and reference from this point forward
            correction = np.exp(-1j * phi_err)
            beat_signal[boundary:] *= correction
            beat_ref[boundary:] *= correction

        # --- Phase-reference division (removes residual system phase) ---
        ref_mag = np.abs(beat_ref)
        valid = ref_mag > np.max(ref_mag) * 0.01
        h_cal = np.zeros(len(beat_signal), dtype=np.complex128)
        h_cal[valid] = beat_signal[valid] / beat_ref[valid]

        # --- Construct equivalent frequency-domain representation ---
        # The stitched beat signal represents the transfer function H(f)
        # across the full synthetic bandwidth
        total_points = num_sub * samples_per_chirp
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
        try:
            self._configure_hardware()
            self._start_tx_rx()

            if test_type == 'linearity':
                result = self._test_linearity()
            elif test_type == 'stitching':
                result = self._test_stitching()
            elif test_type == 'repeatability':
                result = self._test_repeatability()
            elif test_type == 'phase_residual':
                result = self._test_phase_residual()
            else:
                result = {'error': f'Unknown test type: {test_type}'}

            if result is not None and self._callback:
                self._callback(result)

        except Exception as e:
            print(f"[fmcw] Validation test error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.running = False

    def _capture_single_sweep(self):
        """Helper: perform one complete FMCW sweep and return raw beat signals."""
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
        chirp_ref = self._generate_chirp_iq(samples_per_chirp)

        beat_signal = np.zeros(num_sub * samples_per_chirp, dtype=np.complex128)
        beat_ref = np.zeros(num_sub * samples_per_chirp, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        rx_ch1 = bladerf.CHANNEL_RX(1)

        center_freqs = np.array([start + sub_bw // 2 + i * sub_step for i in range(num_sub)])
        freq_norm = (center_freqs - center_freqs[0]) / max(float(center_freqs[-1] - center_freqs[0]), 1)
        rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        # TX is already running from _start_tx_rx

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
            beat_signal[idx_start:idx_end] = sig_accum * np.conj(chirp_ref)
            beat_ref[idx_start:idx_end] = ref_accum * np.conj(chirp_ref)

            if self._callback and i % 5 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_sub,
                    'freq_mhz': center / 1e6,
                })

        return beat_signal, beat_ref, samples_per_chirp, num_sub

    def _test_linearity(self):
        """Test chirp linearity via cable-through.

        Measures residual phase error after de-chirp on the cable reference.
        A perfect chirp + perfect cable → pure single-tone beat → linear phase.
        Deviation from linear = chirp non-linearity + filter distortion.
        """
        beat_signal, beat_ref, spc, num_sub = self._capture_single_sweep()
        if beat_ref is None:
            return None

        # Analyze each sub-band independently
        linearity_results = []
        for i in range(num_sub):
            segment = beat_ref[i * spc:(i + 1) * spc]
            phase = np.unwrap(np.angle(segment))
            # Fit linear model
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
            'pass': overall_rms < 5.0,  # <5° RMS is acceptable
            'overall_rms_deg': round(overall_rms, 4),
            'overall_peak_deg': round(overall_peak, 4),
            'threshold_deg': 5.0,
            'per_sub_band': linearity_results,
            'description': 'Chirp linearity test via cable reference. Measures residual phase after linear fit. <5° RMS = good.',
            'timestamp': time.time(),
        }

    def _test_stitching(self):
        """Test sub-band stitching quality.

        Measures: boundary phase jumps before/after correction, ghost peak level
        (PSLR at ±c/(2·sub_bw) multiples), and main lobe width.
        """
        beat_signal, beat_ref, spc, num_sub = self._capture_single_sweep()
        if beat_ref is None:
            return None

        # Measure boundary phase jumps BEFORE correction
        jumps_before = []
        for i in range(1, num_sub):
            boundary = i * spc
            phi_prev = np.angle(beat_ref[boundary - 1])
            phi_curr = np.angle(beat_ref[boundary])
            jump = phi_curr - phi_prev
            # Wrap to [-π, π]
            jump = (jump + np.pi) % (2 * np.pi) - np.pi
            jumps_before.append(float(jump))

        # Apply stitching correction
        beat_signal_corrected = beat_signal.copy()
        beat_ref_corrected = beat_ref.copy()
        for i in range(1, num_sub):
            boundary = i * spc
            phi_prev = np.angle(beat_ref_corrected[boundary - 1])
            phi_curr = np.angle(beat_ref_corrected[boundary])
            phi_err = phi_curr - phi_prev
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            correction = np.exp(-1j * phi_err)
            beat_signal_corrected[boundary:] *= correction
            beat_ref_corrected[boundary:] *= correction

        # Measure boundary phase jumps AFTER correction
        jumps_after = []
        for i in range(1, num_sub):
            boundary = i * spc
            phi_prev = np.angle(beat_ref_corrected[boundary - 1])
            phi_curr = np.angle(beat_ref_corrected[boundary])
            jump = phi_curr - phi_prev
            jump = (jump + np.pi) % (2 * np.pi) - np.pi
            jumps_after.append(float(jump))

        # Range profile of corrected signal (cable-through → single peak)
        ref_mag = np.abs(beat_ref_corrected)
        valid = ref_mag > np.max(ref_mag) * 0.01
        h_cal = np.zeros(len(beat_signal_corrected), dtype=np.complex128)
        h_cal[valid] = beat_signal_corrected[valid] / beat_ref_corrected[valid]

        window = np.hanning(len(h_cal))
        profile = np.abs(np.fft.ifft(h_cal * window))
        profile_db = 20 * np.log10(profile / (np.max(profile) + 1e-12) + 1e-12)

        # Find main peak and sidelobes
        peak_idx = np.argmax(profile)
        peak_val_db = 0.0  # normalized to 0 dB

        # Ghost peak locations: at multiples of c/(2·sub_bw) in range bins
        total_points = len(profile)
        total_bw = self.stop_freq - self.start_freq
        range_per_bin = SPEED_OF_LIGHT / (2 * total_bw) * total_points / total_points
        ghost_range = SPEED_OF_LIGHT / (2 * self.sub_band_bw)
        ghost_bin = int(ghost_range / (SPEED_OF_LIGHT / (2 * total_bw / total_points * total_points)))

        # PSLR: ratio of highest sidelobe to main peak
        # Exclude ±5 bins around main peak
        mask = np.ones(len(profile_db), dtype=bool)
        mask[max(0, peak_idx - 5):min(len(mask), peak_idx + 6)] = False
        if np.any(mask):
            pslr = float(np.max(profile_db[mask]))
        else:
            pslr = -100.0

        # Main lobe -3dB width
        half_profile = profile_db[:len(profile_db) // 2]
        above_3db = np.where(half_profile > -3.0)[0]
        if len(above_3db) > 1:
            lobe_width_bins = int(above_3db[-1] - above_3db[0])
        else:
            lobe_width_bins = 1

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

        Runs two back-to-back sweeps and measures the residual difference.
        Bad stitching is non-deterministic (PLL settling varies), so low
        repeatability indicates stitching correction isn't working.
        """
        # First sweep
        beat_sig1, beat_ref1, spc, num_sub = self._capture_single_sweep()
        if beat_sig1 is None:
            return None

        # Apply stitching to first sweep
        for i in range(1, num_sub):
            boundary = i * spc
            phi_err = np.angle(beat_ref1[boundary]) - np.angle(beat_ref1[boundary - 1])
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            beat_sig1[boundary:] *= np.exp(-1j * phi_err)
            beat_ref1[boundary:] *= np.exp(-1j * phi_err)

        # Second sweep (TX already running)
        beat_sig2, beat_ref2, _, _ = self._capture_single_sweep()
        if beat_sig2 is None:
            return None

        # Apply stitching to second sweep
        for i in range(1, num_sub):
            boundary = i * spc
            phi_err = np.angle(beat_ref2[boundary]) - np.angle(beat_ref2[boundary - 1])
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            beat_sig2[boundary:] *= np.exp(-1j * phi_err)
            beat_ref2[boundary:] *= np.exp(-1j * phi_err)

        # Phase-reference division for both
        ref_mag1 = np.abs(beat_ref1)
        valid1 = ref_mag1 > np.max(ref_mag1) * 0.01
        h1 = np.zeros(len(beat_sig1), dtype=np.complex128)
        h1[valid1] = beat_sig1[valid1] / beat_ref1[valid1]

        ref_mag2 = np.abs(beat_ref2)
        valid2 = ref_mag2 > np.max(ref_mag2) * 0.01
        h2 = np.zeros(len(beat_sig2), dtype=np.complex128)
        h2[valid2] = beat_sig2[valid2] / beat_ref2[valid2]

        # Range profiles
        window = np.hanning(len(h1))
        p1 = np.fft.ifft(h1 * window)
        p2 = np.fft.ifft(h2 * window)

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

        The cable has linear phase vs frequency. After stitching, any deviation
        from linear indicates residual errors. This is the most direct measure
        of overall synthetic bandwidth quality.
        """
        beat_signal, beat_ref, spc, num_sub = self._capture_single_sweep()
        if beat_ref is None:
            return None

        # Apply stitching
        for i in range(1, num_sub):
            boundary = i * spc
            phi_err = np.angle(beat_ref[boundary]) - np.angle(beat_ref[boundary - 1])
            phi_err = (phi_err + np.pi) % (2 * np.pi) - np.pi
            beat_signal[boundary:] *= np.exp(-1j * phi_err)
            beat_ref[boundary:] *= np.exp(-1j * phi_err)

        # Phase-reference division
        ref_mag = np.abs(beat_ref)
        valid = ref_mag > np.max(ref_mag) * 0.01
        h_cal = np.zeros(len(beat_signal), dtype=np.complex128)
        h_cal[valid] = beat_signal[valid] / beat_ref[valid]

        # Full phase across stitched bandwidth
        phase = np.unwrap(np.angle(h_cal[valid]))
        indices = np.where(valid)[0].astype(np.float64)

        # Linear fit
        coeffs = np.polyfit(indices, phase, 1)
        residual = phase - np.polyval(coeffs, indices)

        rms_residual = float(np.sqrt(np.mean(residual**2)))
        peak_residual = float(np.max(np.abs(residual)))

        # Downsample residual for transport
        step = max(1, len(residual) // 500)
        residual_plot = residual[::step]

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
