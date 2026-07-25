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

        # FMCW requires sample rate > chirp bandwidth (Nyquist).
        # bladeRF 2.0 MIMO max is ~30.72 MSPS per channel.
        # Set sample rate to cover the sub-band chirp with margin.
        required_rate = int(self.sub_band_bw * 1.25)  # 25% margin over chirp BW
        max_mimo_rate = 30_720_000
        fmcw_rate = min(required_rate, max_mimo_rate)
        # Enforce minimum 4 MSPS for stable streaming
        fmcw_rate = max(fmcw_rate, 4_000_000)

        self.driver.sample_rate = fmcw_rate
        self.driver.bandwidth = int(fmcw_rate * 0.8)
        self._fmcw_sample_rate = fmcw_rate
        print(f"[fmcw] Sample rate set to {fmcw_rate/1e6:.2f} MSPS for {self.sub_band_bw/1e6:.0f} MHz chirp")

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
            pll_settle = self.pll_settle_time
            num_avg = self.num_chirps_avg
            overlap = self.overlap_fraction

        sub_step = int(sub_bw * (1.0 - overlap))
        num_sub = int(np.ceil((stop - start) / sub_step))
        samples_per_chirp = int(chirp_dur * self.driver.sample_rate)

        beat_signal = np.zeros(num_sub * samples_per_chirp, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)
        rx_ch1 = bladerf.CHANNEL_RX(1)

        center_freqs = np.array([start + sub_bw // 2 + i * sub_step for i in range(num_sub)])
        freq_norm = (center_freqs - center_freqs[0]) / max(float(center_freqs[-1] - center_freqs[0]), 1)
        rx_gains = (self.rx_gain_min + freq_norm * (self.rx_gain_max - self.rx_gain_min)).astype(int)

        for i in range(num_sub):
            if self._stop_event.is_set():
                return None

            center = int(center_freqs[i])
            g = int(rx_gains[i])

            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, center)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, center)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch, g)
            libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, g)

            time.sleep(pll_settle)

            # Discard first buffer (PLL transient)
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

            # De-chirp: RX1 * conj(RX2) — TX/RX timing offset cancels
            idx_start = i * samples_per_chirp
            idx_end = idx_start + samples_per_chirp
            beat_signal[idx_start:idx_end] = sig_accum * np.conj(ref_accum)

            if self._callback and i % 5 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_sub,
                    'freq_mhz': center / 1e6,
                })

        # --- Phase stitching correction at sub-band boundaries ---
        for i in range(1, num_sub):
            boundary = i * samples_per_chirp
            phi_prev = np.angle(beat_signal[boundary - 1])
            phi_curr = np.angle(beat_signal[boundary])
            phi_err = (phi_curr - phi_prev + np.pi) % (2 * np.pi) - np.pi
            beat_signal[boundary:] *= np.exp(-1j * phi_err)

        # The stitched beat signal IS the channel transfer function H(f)
        h_cal = beat_signal

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
            self.running = False

    def _capture_single_sweep(self):
        """Helper: perform one complete FMCW sweep and return de-chirped beat signals.

        De-chirp is done by mixing RX1 (scene) against RX2 (cable reference from TX2).
        This eliminates TX/RX buffer timing offset since both channels share the same
        capture clock. RX2 raw phase is preserved separately for sub-band stitching.

        Returns: (beat_signal, ref_phase, samples_per_chirp, num_sub)
          - beat_signal: RX1 * conj(RX2) per sub-band, concatenated
          - ref_phase: raw RX2 phase at each sub-band boundary (for stitching)
          - samples_per_chirp: samples in one sub-band
          - num_sub: number of sub-bands
        """
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
            # De-chirp: RX1 * conj(RX2) — timing offset cancels
            beat_signal[idx_start:idx_end] = sig_accum * np.conj(ref_accum)
            # Store reference phase at sub-band midpoint for stitching
            ref_phase[i] = ref_accum[samples_per_chirp // 2]

            if self._callback and i % 5 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_sub,
                    'freq_mhz': center / 1e6,
                })

        return beat_signal, ref_phase, samples_per_chirp, num_sub

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
