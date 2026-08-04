"""Chirp-based stepped-frequency radar engine with pulse compression.

At each step frequency, transmits a 15 MHz / 50 us chirp and performs matched
filtering (de-chirp + coherent sum) for time-bandwidth processing gain of
BW*T = 750 (28.7 dB) over a CW tone. RX2 cable reference provides per-step
phase correction (same as SFCW engine). Range profile = IFFT across steps.

At our operating parameters (15 MHz chirp BW, <10m targets), beat frequencies
(~3.6 kHz at 1.8m) fall well within the DC FFT bin (20 kHz spacing). Intra-chirp
range resolution would require either >80 MHz chirp BW or >5ms chirp duration.
The chirp's value here is:
  - Pulse compression SNR gain vs CW
  - Better chirp-boundary detection via cross-correlation with RX2
  - Rejection of narrowband interference (spread across de-chirp output)
"""

import threading
import time
import numpy as np

from bladerf_driver import BladeRFDriver
from bladerf._bladerf import libbladeRF, ffi
import bladerf

SPEED_OF_LIGHT = 299_792_458

CHIRP_BW = 15_000_000
CHIRP_DURATION = 50e-6
SAMPLE_RATE = 20_000_000


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
        # Chirp parameters
        self.chirp_bw = CHIRP_BW
        self.chirp_duration = CHIRP_DURATION
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

    @property
    def samples_per_chirp(self):
        return int(SAMPLE_RATE * self.chirp_duration)

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
            'chirp_bw': self.chirp_bw,
            'chirp_duration': self.chirp_duration,
            'samples_per_chirp': self.samples_per_chirp,
            'processing_gain_db': 10 * np.log10(self.samples_per_chirp),
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

    def _gen_chirp_ref(self):
        """Generate complex chirp reference for cross-correlation and de-chirp."""
        n = self.samples_per_chirp
        t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
        f0 = -self.chirp_bw / 2
        f1 = self.chirp_bw / 2
        phase = 2 * np.pi * (f0 * t + (f1 - f0) / (2 * self.chirp_duration) * t ** 2)
        return np.exp(1j * phase)

    def _configure_hardware(self):
        self.driver.tx_gain = self.tx1_gain
        self.driver.rx_gain = self.rx1_gain
        self.driver.tx2_gain = self.tx2_gain
        self.driver.rx2_gain = self.rx2_gain
        self.driver.sample_rate = SAMPLE_RATE
        self.driver.bandwidth = CHIRP_BW
        self.driver.set_waveform('chirp', chirp_bw=self.chirp_bw,
                                 chirp_duration=self.chirp_duration, amplitude=0.9)
        self.driver._configure_channels_dual()

    def _start_tx_rx(self):
        self._rx_latest = (None, None)
        self._rx_event = threading.Event()
        # Capture 2 chirp periods -- enough to find alignment via cross-correlation
        self._rx_num_samples = self.samples_per_chirp * 2
        self._chirp_ref = self._gen_chirp_ref()
        self.driver.start_tx_dual()
        self.driver.start_rx_dual(self._rx_capture, num_samples=self._rx_num_samples)
        time.sleep(0.05)

        dev_ptr = self.driver.device.dev[0]
        libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(0), libbladeRF.BLADERF_GAIN_MGC)
        libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(1), libbladeRF.BLADERF_GAIN_MGC)
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), int(self.rx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(1), int(self.rx2_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), int(self.tx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(1), int(self.tx2_gain))

        self.driver.run_oneshot_calibration()

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
        """Chirp-based SFCW with matched-filter processing gain.

        At each step frequency, transmits a chirp and performs matched filtering
        (cross-correlation with chirp reference) on the RX signal. This gives
        time-bandwidth product processing gain (BW*T = 750 = 28.7 dB) over CW.

        With 15 MHz chirp BW and 50μs duration at <10m range, the beat frequency
        (~3.6 kHz for 1.8m target) falls within the DC FFT bin (20 kHz spacing).
        All range information comes from the stepped-frequency IFFT, same as SFCW.
        The chirp adds SNR via pulse compression, not additional range bins.

        H(f_i) = matched_filter_peak(RX1) / mean(dechirp(RX2))  per step.
        Range profile = IFFT(H) across all steps.
        """
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step_size = self.step_size

        num_steps = int((stop - start) / step_size) + 1
        freqs = np.linspace(start, stop, num_steps).astype(np.int64)
        h_cal = np.zeros(num_steps, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)

        settle = self.pll_settle_time
        num_buffers = self.num_buffers
        chirp_ref = self._chirp_ref
        spc = self.samples_per_chirp

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

            accum = 0j
            captured = 0
            for _ in range(num_buffers):
                self._rx_event.clear()
                if not self._rx_event.wait(timeout=1.0):
                    break

                rx1_raw, rx2_raw = self._rx_latest
                if rx1_raw is None or rx2_raw is None:
                    continue

                i1 = rx1_raw[0::2].astype(np.float64) / 2047.0
                q1 = rx1_raw[1::2].astype(np.float64) / 2047.0
                rx1_iq = i1 + 1j * q1

                i2 = rx2_raw[0::2].astype(np.float64) / 2047.0
                q2 = rx2_raw[1::2].astype(np.float64) / 2047.0
                rx2_iq = i2 + 1j * q2

                # Cross-correlate RX2 with chirp reference to find chirp start
                xcorr = np.abs(np.correlate(rx2_iq, chirp_ref, mode='valid'))
                k = int(np.argmax(xcorr))
                if k + spc > len(rx1_iq):
                    k = max(0, len(rx1_iq) - spc)

                seg1 = rx1_iq[k:k + spc]
                seg2 = rx2_iq[k:k + spc]

                # De-chirp both channels
                dechirp1 = seg1 * np.conj(chirp_ref[:len(seg1)])
                dechirp2 = seg2 * np.conj(chirp_ref[:len(seg2)])

                # Matched filter output: coherent sum of de-chirped samples
                # For targets within DC FFT bin (< range_per_bin ≈ 10m),
                # this equals N × H(f) where N = spc (processing gain)
                mf1 = np.sum(dechirp1)
                # Reference channel DC (cable loopback = zero-range target)
                ref_dc = np.sum(dechirp2)

                if abs(ref_dc) > 1e-6:
                    accum += mf1 / ref_dc
                    captured += 1

            h_cal[i] = accum / max(captured, 1)

            if self._callback and i % 10 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_steps,
                    'freq_mhz': freqs[i] / 1e6,
                })

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
