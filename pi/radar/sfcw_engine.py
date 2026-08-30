"""Stepped-Frequency Continuous Wave (SFCW) radar engine.

Orchestrates the bladeRF to sweep through discrete frequency steps,
capture IQ at each, and compute range profiles via IFFT.

Uses dual-channel reference: TX1+RX1 for antenna signal, TX2+RX2 as
phase reference (short cable loopback). Dividing signal by reference
eliminates random PLL phase offsets between TX and RX synthesizers.
"""

import threading
import time
import numpy as np
from datetime import datetime

from bladerf_driver import BladeRFDriver
from bladerf._bladerf import ffi, libbladeRF
import bladerf

SPEED_OF_LIGHT = 299_792_458

# Sweeps run back-to-back by run_coherence_test(). Metrics are computed between each
# consecutive pair, so this yields COHERENCE_SWEEP_COUNT - 1 repeatability/correlation
# values. SfcwPanel.jsx's button label mirrors this number and must track it.
COHERENCE_SWEEP_COUNT = 100

# Sweep logging, ported from version_bluestar's sfcw_engine so both trees read the
# same way. Every line carries its own microsecond wall-clock prefix — for the USB
# markers (CMD SENT / ACK RECEIVED) that prefix *is* the measurement, printed at the
# exact moment of the event, so the log can be read as a transaction trace and not
# just a summary. Toggle with SFCWEngine.set_params(timing_log=False).
_TIMING_LOG = True


def set_timing_log(enabled):
    global _TIMING_LOG
    _TIMING_LOG = bool(enabled)


def _emit(line):
    """print() that degrades to ASCII rather than raising on a non-UTF-8 console.

    The Pi's journal is UTF-8, so the box-drawing and µ characters render there —
    but a cp1252 console (or LANG=C) would otherwise raise UnicodeEncodeError from
    inside _sweep_core and take the sweep down with it.
    """
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode('ascii', 'replace').decode('ascii'), flush=True)


def _log_timing(event, **details):
    """Log timing events in human-readable format."""
    if not _TIMING_LOG:
        return
    timestamp = datetime.now().strftime('%H:%M:%S.%f')  # Microsecond precision
    detail_str = ' '.join(f'{k}={v}' for k, v in details.items()) if details else ''
    _emit(f"[{timestamp}] SFCW | {event:<30} {detail_str}")


def _log_separator(char='─'):
    """Print a visual separator line."""
    if not _TIMING_LOG:
        return
    timestamp = datetime.now().strftime('%H:%M:%S.%f')  # Microsecond precision
    _emit(f"[{timestamp}] SFCW | {char * 70}")


def _format_duration(seconds):
    """Format duration in human-readable way."""
    if seconds < 0.001:
        return f"{seconds*1000000:.0f}µs"
    elif seconds < 1:
        return f"{seconds*1000:.1f}ms"
    else:
        return f"{seconds:.3f}s"

# Master quick-tune table: covers the whole usable band at a fixed grid, generated
# once per device connection. Any sweep's start/stop/step is snapped onto this grid
# (see _snap_freq/_snap_step), so retuning never needs the table to be regenerated —
# start/stop/step can change freely at runtime with no device reset. See CLAUDE.md
# "Quick-tune master table" for the history of why this replaced per-grid caching.
#
# bladerf_get_quick_tune() isn't a stateless read — every call WRITES a new fastlock
# profile into a fixed-size on-device table (bladerf2.c: board_data->quick_tune_tx/
# rx_profile, capped at NUM_BBP_FASTLOCK_PROFILES). That counter only resets on a
# full device close+reopen. Past the cap, bladerf_get_quick_tune() returns an error
# and leaves the profile struct unpopulated — MAX_QUICK_TUNE_PROFILES here must stay
# under that hardware ceiling or the table silently contains garbage profiles for
# every frequency past it (this happened: a prior 1-6 GHz/10 MHz table needed 501
# profiles against a 256 cap).
MAX_QUICK_TUNE_PROFILES = 256  # NUM_BBP_FASTLOCK_PROFILES, fpga_common/bladerf2_common.h
QT_MASTER_START_FREQ = 2_000_000_000
QT_MASTER_STOP_FREQ = 5_000_000_000
QT_MASTER_STEP = 20_000_000


class SFCWEngine:
    def __init__(self, driver: BladeRFDriver):
        self.driver = driver
        self.start_freq = 2_000_000_000
        self.stop_freq = 5_000_000_000
        self.step_size = 60_000_000
        self.num_buffers = 10
        # 0 = discard nothing after a retune; the first buffer that arrives is kept.
        # See CLAUDE.md "Sweep Timing" for the settle_count regression history.
        self.settle_count = 0
        self.tx1_gain = 50
        self.rx1_gain = 25
        self.tx2_gain = 30
        self.rx2_gain = 20
        self.rx_gain_min = 5
        self.rx_gain_max = 38
        self.range_offset = 0.5
        self.bscan_avg_count = 1
        self.bscan_primer = False
        self.timing_log = True
        self.running = False
        self._stop_event = threading.Event()
        self._thread = None
        self._callback = None
        self._lock = threading.Lock()
        self._fpga_tuning = False
        self._gains_dirty = False
        self._warm = False
        self._sweep_lock = threading.Lock()
        self._qt_master_freqs = None
        self._qt_master_rx = None
        self._qt_master_tx = None
        self._use_quick_tune = True

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

    @staticmethod
    def _snap_freq(value):
        """Round to the nearest 10 MHz grid point and clamp into the master table's range."""
        snapped = round(float(value) / QT_MASTER_STEP) * QT_MASTER_STEP
        return int(min(max(snapped, QT_MASTER_START_FREQ), QT_MASTER_STOP_FREQ))

    @staticmethod
    def _snap_step(value):
        snapped = round(float(value) / QT_MASTER_STEP) * QT_MASTER_STEP
        return int(max(snapped, QT_MASTER_STEP))

    def set_params(self, **kwargs):
        with self._lock:
            if 'start_freq' in kwargs:
                self.start_freq = self._snap_freq(kwargs['start_freq'])
            if 'stop_freq' in kwargs:
                self.stop_freq = self._snap_freq(kwargs['stop_freq'])
            if 'step_size' in kwargs:
                self.step_size = self._snap_step(kwargs['step_size'])
            if 'num_buffers' in kwargs:
                self.num_buffers = max(1, int(kwargs['num_buffers']))
            if 'settle_count' in kwargs:
                self.settle_count = max(0, int(kwargs['settle_count']))
            if 'timing_log' in kwargs:
                self.timing_log = bool(kwargs['timing_log'])
                set_timing_log(self.timing_log)
            if 'tx1_gain' in kwargs:
                self.tx1_gain = int(kwargs['tx1_gain'])
                self._gains_dirty = True
            if 'rx1_gain' in kwargs:
                self.rx1_gain = int(kwargs['rx1_gain'])
                self._gains_dirty = True
            if 'tx2_gain' in kwargs:
                self.tx2_gain = int(kwargs['tx2_gain'])
                self._gains_dirty = True
            if 'rx2_gain' in kwargs:
                self.rx2_gain = int(kwargs['rx2_gain'])
                self._gains_dirty = True
            if 'rx_gain_min' in kwargs:
                self.rx_gain_min = int(kwargs['rx_gain_min'])
            if 'rx_gain_max' in kwargs:
                self.rx_gain_max = int(kwargs['rx_gain_max'])
            if 'range_offset' in kwargs:
                self.range_offset = float(kwargs['range_offset'])
            if 'bscan_avg_count' in kwargs:
                self.bscan_avg_count = max(1, int(kwargs['bscan_avg_count']))
            if 'bscan_primer' in kwargs:
                self.bscan_primer = bool(kwargs['bscan_primer'])

    def get_params(self):
        return {
            'start_freq': self.start_freq,
            'stop_freq': self.stop_freq,
            'step_size': self.step_size,
            'num_buffers': self.num_buffers,
            'settle_count': self.settle_count,
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
            'bscan_avg_count': self.bscan_avg_count,
            'bscan_primer': self.bscan_primer,
            'timing_log': self.timing_log,
        }

    def run_coherence_test(self, callback=None):
        """Run COHERENCE_SWEEP_COUNT consecutive sweeps and compute repeatability +
        correlation metrics between each consecutive pair.

        Runs in a new thread. Results sent via callback as a dict with type='coherence_result'.
        """
        if self.running:
            return
        self.running = True
        self._stop_event.clear()
        t = threading.Thread(target=self._coherence_test_worker, args=(callback,), daemon=True)
        t.start()

    def _coherence_test_worker(self, callback):
        try:
            self._configure_hardware()
            self._start_tx_rx()
            time.sleep(0.1)

            sweeps = []
            for i in range(COHERENCE_SWEEP_COUNT):
                if self._stop_event.is_set():
                    return
                if callback:
                    callback({'type': 'progress', 'step': i,
                              'total': COHERENCE_SWEEP_COUNT, 'freq_mhz': 0})
                result = self._perform_sweep()
                if result and result.get('type') == 'range_profile':
                    h_cal = np.array(result['h_cal_real']) + 1j * np.array(result['h_cal_imag'])
                    sweeps.append(h_cal)

            if len(sweeps) < 2:
                if callback:
                    callback({'error': 'Not enough sweeps completed'})
                return

            reps = []
            corrs = []
            for i in range(len(sweeps) - 1):
                a_raw = sweeps[i]
                b_raw = sweeps[i + 1]
                residual = b_raw - a_raw
                rep = 1.0 - (np.std(residual) / np.std(a_raw))
                reps.append(float(rep))
                a = a_raw - np.mean(a_raw)
                b = b_raw - np.mean(b_raw)
                corr = np.abs(np.sum(a * np.conj(b))) / (
                    np.sqrt(np.sum(np.abs(a) ** 2)) * np.sqrt(np.sum(np.abs(b) ** 2))
                )
                corrs.append(float(corr))

            if callback:
                callback({
                    'type': 'coherence_result',
                    'repeatability': reps,
                    'correlation': corrs,
                    'avg_repeatability': float(np.mean(reps)),
                    'avg_correlation': float(np.mean(corrs)),
                    'num_sweeps': len(sweeps),
                })
        except Exception as e:
            if callback:
                callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.running = False

    def run_single(self, callback):
        """Run a single sweep and stop. Used for B-scan position captures."""
        if self._warm:
            self._callback = callback
            t = threading.Thread(target=self._warm_sweep_worker, args=(callback,), daemon=True)
            t.start()
            return
        if self.running:
            return
        self._callback = callback
        self._stop_event.clear()
        self.running = True
        self._thread = threading.Thread(target=self._single_sweep_worker, daemon=True)
        self._thread.start()

    def _warm_sweep_worker(self, callback):
        """Perform averaged sweeps with hardware already running (warm B-scan mode)."""
        with self._sweep_lock:
            try:
                t_capture_start = time.perf_counter()
                if self.bscan_primer:
                    self._perform_sweep_raw()

                avg_count = self.bscan_avg_count
                if avg_count <= 1:
                    result = self._perform_sweep()
                else:
                    h_cal_accum = None
                    completed = 0
                    timings = []
                    for i in range(avg_count):
                        raw, timing = self._perform_sweep_raw()
                        if raw is None:
                            continue
                        if timing is not None:
                            timings.append(timing)
                        if h_cal_accum is None:
                            h_cal_accum = raw.copy()
                        else:
                            h_cal_accum += raw
                        completed += 1
                    if completed == 0:
                        result = None
                    else:
                        h_cal_avg = h_cal_accum / completed
                        t_process_start = time.perf_counter()
                        result = self._process_h_cal(h_cal_avg)
                        timing = self._merge_timings(timings)
                        if timing is not None:
                            timing['sweeps_averaged'] = completed
                            timing['process_ms'] = round(
                                (time.perf_counter() - t_process_start) * 1e3, 3)
                            timing['sweep_total_ms'] = round(
                                (time.perf_counter() - t_capture_start) * 1e3, 3)
                            result['timing'] = timing
                            self._log_sweep_summary(timing, label='WARM SWEEP')
                if result is not None and callback:
                    callback(result)
            except Exception as e:
                print(f"[sfcw] Warm sweep error: {e}")
                if callback:
                    callback({'error': str(e)})

    def _single_sweep_worker(self):
        try:
            self._configure_hardware()
            self._start_tx_rx()
            time.sleep(0.1)
            result = self._perform_sweep()
            if result is not None and self._callback:
                self._callback(result)
        except Exception as e:
            print(f"[sfcw] Single sweep error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.running = False

    def warm_up(self):
        """Start hardware and keep it running for multiple on-demand sweeps (B-scan mode)."""
        if self._warm or self.running:
            return
        self._stop_event.clear()
        self._configure_hardware()
        self._start_tx_rx()
        time.sleep(0.1)
        self._perform_sweep_raw()
        self._warm = True
        self.running = True

    def cool_down(self):
        """Stop hardware after warm B-scan session."""
        if not self._warm:
            return
        self._stop_tx_rx()
        self._warm = False
        self.running = False

    def start(self, callback):
        if self.running:
            return
        self._callback = callback
        self._stop_event.clear()
        self.running = True
        self._thread = threading.Thread(target=self._sweep_loop, daemon=True)
        self._thread.start()

    def stop(self):
        if not self.running:
            return
        if self._warm:
            self.cool_down()
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
                if not self.driver.tx_running or not self.driver.rx_running:
                    print("[sfcw] ERROR: TX/RX stream died unexpectedly")
                    if self._callback:
                        self._callback({'error': 'USB stream died — restart sweep'})
                    break
                if self._gains_dirty:
                    self._apply_gains()
                range_profile = self._perform_sweep()
                if range_profile is not None and self._callback:
                    self._callback(range_profile)

        except Exception as e:
            print(f"[sfcw] Sweep error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.running = False

    def _ensure_master_quick_tune_table(self):
        """Generate the full-band quick_tune table once, covering QT_MASTER_START_FREQ..
        QT_MASTER_STOP_FREQ at QT_MASTER_STEP spacing.

        This is the one place that pays the full-VCO-cal cost (one bladerf_set_frequency
        per master grid point) and consumes the device's fixed BBP fastlock profile
        budget (MAX_QUICK_TUNE_PROFILES, see the module comment). It's independent of
        start_freq/stop_freq/step_size, so it only needs to happen once per device
        connection: after this, changing sweep params never requires a device reset,
        since every sweep's frequencies are just slices of this table (see
        _build_sweep_grid). Must be called before streaming starts and before switching
        to FPGA tuning mode (set_frequency needs normal tuning mode to calibrate).
        """
        if self._qt_master_freqs is not None:
            return

        freqs = np.arange(QT_MASTER_START_FREQ, QT_MASTER_STOP_FREQ + QT_MASTER_STEP,
                           QT_MASTER_STEP, dtype=np.int64)
        if len(freqs) > MAX_QUICK_TUNE_PROFILES:
            raise RuntimeError(
                f"Master quick-tune table needs {len(freqs)} profiles but the bladeRF2 "
                f"firmware caps BBP fastlock profiles at {MAX_QUICK_TUNE_PROFILES} per "
                f"direction. Narrow QT_MASTER_STOP_FREQ - QT_MASTER_START_FREQ or widen "
                f"QT_MASTER_STEP in sfcw_engine.py."
            )

        dev_ptr = self.driver.device.dev[0]

        qt_rx = []
        qt_tx = []
        for f in freqs:
            f_int = int(f)
            libbladeRF.bladerf_set_frequency(dev_ptr, bladerf.CHANNEL_RX(0), f_int)
            libbladeRF.bladerf_set_frequency(dev_ptr, bladerf.CHANNEL_TX(0), f_int)
            qr = ffi.new('struct bladerf_quick_tune *')
            qt_val = ffi.new('struct bladerf_quick_tune *')
            rc_rx = libbladeRF.bladerf_get_quick_tune(dev_ptr, bladerf.CHANNEL_RX(0), qr)
            rc_tx = libbladeRF.bladerf_get_quick_tune(dev_ptr, bladerf.CHANNEL_TX(0), qt_val)
            if rc_rx != 0 or rc_tx != 0:
                raise RuntimeError(
                    f"bladerf_get_quick_tune failed at {f_int/1e6:.0f} MHz "
                    f"(rx_rc={rc_rx}, tx_rc={rc_tx}) after {len(qt_rx)} profiles built — "
                    f"likely exhausted the device's {MAX_QUICK_TUNE_PROFILES}-profile "
                    f"fastlock table. A device reset reclaims the budget (fresh "
                    f"bladerf_open() resets the on-device counter to 0)."
                )
            qt_rx.append(qr)
            qt_tx.append(qt_val)

        self._qt_master_freqs = freqs
        self._qt_master_rx = qt_rx
        self._qt_master_tx = qt_tx
        print(f"[sfcw] Generated master quick_tune table: {len(freqs)} profiles "
              f"({QT_MASTER_START_FREQ/1e9:.2f}-{QT_MASTER_STOP_FREQ/1e9:.2f} GHz, "
              f"{QT_MASTER_STEP/1e6:.0f} MHz spacing)")

    def invalidate_quick_tune_table(self):
        """Drop the cached master table so it regenerates on next use.

        Call after a device.reset() — a fresh device open can leave the AD9361 in a
        state where previously-captured quick_tune profiles no longer apply.
        """
        self._qt_master_freqs = None
        self._qt_master_rx = None
        self._qt_master_tx = None

    def _build_sweep_grid(self, start, stop, step):
        """Compute this sweep's frequencies and, if available, their quick_tune profiles
        by indexing straight into the master table — no regeneration needed regardless
        of what start/stop/step are, as long as they're on the master's 10 MHz grid
        within its range (set_params() guarantees this via _snap_freq/_snap_step).
        """
        num_steps = int((stop - start) / step) + 1

        if self._use_quick_tune and self._qt_master_freqs is not None:
            n_master = len(self._qt_master_freqs)
            start_idx = int(round((start - QT_MASTER_START_FREQ) / QT_MASTER_STEP))
            step_idx = max(1, int(round(step / QT_MASTER_STEP)))
            idxs = np.clip(start_idx + np.arange(num_steps) * step_idx, 0, n_master - 1)
            freqs = self._qt_master_freqs[idxs]
            qt_rx = [self._qt_master_rx[k] for k in idxs]
            qt_tx = [self._qt_master_tx[k] for k in idxs]
            return freqs, qt_rx, qt_tx

        freqs = (start + np.arange(num_steps) * step).astype(np.int64)
        return freqs, None, None

    def _configure_hardware(self):
        self.driver.tx_gain = self.tx1_gain
        self.driver.rx_gain = self.rx1_gain
        self.driver.tx2_gain = self.tx2_gain
        self.driver.rx2_gain = self.rx2_gain
        self.driver.sample_rate = 10_000_000
        self.driver.bandwidth = 8_000_000
        self.driver.set_waveform('cw', offset=100_000, amplitude=0.9)
        if self._use_quick_tune:
            self._ensure_master_quick_tune_table()
        self.driver._configure_channels_dual()
        # NOTE: do NOT call driver.set_tuning_mode_fpga() here. On the bladeRF 2.0
        # micro, BLADERF_TUNING_MODE_FPGA accepts the call (rc=0) but then kills the
        # RX_X2 data path: sync_rx() starts timing out ~8 buffers later with
        # "Transfer timed out for RX buffer", so the sweep gets no data at all.
        # Bisected 2026-08-28 against libbladeRF 2.6.1 / FPGA 0.16.0 (reproduced with
        # both the flashed image and Nuand's official v0.16.0 loaded into RAM, so it
        # is not an FPGA-image problem). libbladeRF's own bladerf2 default_tuning_mode()
        # hardcodes mode = BLADERF_TUNING_MODE_HOST and only reaches FPGA mode via the
        # BLADERF_DEFAULT_TUNING_MODE=fpga env var, citing "errata related to
        # FPGA-based tuning" -- FPGA tuning is simply not a supported default here.
        # Host tuning costs nothing measurable: quick-tune bladerf_schedule_retune()
        # still works (rc=0) and a 51-step sweep runs in 230 ms (4.35 Hz).
        self._fpga_tuning = False

    def _start_tx_rx(self):
        self._rx_cond = threading.Condition()
        self._rx_latest = None
        self._rx_seq = 0
        n = 4096
        t = np.arange(n, dtype=np.float64) / self.driver.sample_rate
        self._ref_tone = np.exp(-1j * 2 * np.pi * self.driver.cw_offset * t)
        self._ref_tone_scaled = self._ref_tone / 2047.0
        self.driver.start_tx_dual()
        self.driver.start_rx_dual(self._rx_capture, num_samples=n)
        time.sleep(0.05)

        # enable_module() resets gain state, so re-push after modules are enabled.
        # driver.tx_gain/rx_gain/tx2_gain/rx2_gain were already synced from
        # self.tx1_gain/rx1_gain/tx2_gain/rx2_gain in _configure_hardware().
        self.driver.reapply_dual_gains()

    def _apply_gains(self):
        dev_ptr = self.driver.device.dev[0]
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(0), int(self.tx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(1), int(self.tx2_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(0), int(self.rx1_gain))
        libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(1), int(self.rx2_gain))
        self._gains_dirty = False

    def _stop_tx_rx(self):
        self.driver.stop_rx_dual()
        self.driver.stop_tx_dual()
        # Restore single-channel config so calib panel works after SFCW
        self.driver._configure_channels()



    def _rx_capture(self, rx1_iq, rx2_iq):
        with self._rx_cond:
            self._rx_latest = (rx1_iq, rx2_iq)
            self._rx_seq += 1
            self._rx_cond.notify_all()

    def _perform_sweep(self):
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step = self.step_size
            num_buffers = self.num_buffers
            settle_count = self.settle_count

        t_sweep_start = time.perf_counter()
        freqs, qt_rx, qt_tx = self._build_sweep_grid(start, stop, step)
        grid_ms = (time.perf_counter() - t_sweep_start) * 1e3
        num_steps = len(freqs)

        _log_separator('═')
        _log_timing("SWEEP START",
                    start=f"{start/1e9:.3f}GHz",
                    stop=f"{stop/1e9:.3f}GHz",
                    step=f"{step/1e6:.0f}MHz",
                    num_steps=num_steps,
                    num_buffers=num_buffers,
                    settle_count=settle_count)

        def progress(i):
            if self._callback and i % 10 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_steps,
                    'freq_mhz': freqs[i] / 1e6,
                })

        t_capture_start = time.perf_counter()
        h_cal, dropped_steps, timing = self._sweep_core(
            freqs, qt_rx, qt_tx, num_buffers, settle_count, progress)
        capture_duration = time.perf_counter() - t_capture_start
        if h_cal is None:
            return None

        _log_timing("CAPTURE COMPLETE",
                    duration=_format_duration(capture_duration),
                    valid_steps=f"{num_steps-dropped_steps}/{num_steps}")

        if dropped_steps > 0:
            print(f"[sfcw] WARNING: {dropped_steps}/{num_steps} steps had incomplete captures")

        t_process_start = time.perf_counter()
        result = self._process_h_cal(h_cal)
        postproc_duration = time.perf_counter() - t_process_start
        timing['grid_build_ms'] = round(grid_ms, 3)
        timing['process_ms'] = round(postproc_duration * 1e3, 3)
        timing['sweep_total_ms'] = round((time.perf_counter() - t_sweep_start) * 1e3, 3)
        result['timing'] = timing

        self._log_sweep_summary(timing)
        _log_timing("SWEEP END",
                    total=_format_duration(timing['sweep_total_ms'] / 1e3),
                    capture=_format_duration(capture_duration),
                    postproc=_format_duration(postproc_duration))
        _log_separator('═')
        return result

    def _perform_sweep_raw(self):
        """Like _perform_sweep but returns (raw h_cal array, timing) for averaging."""
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step = self.step_size
            num_buffers = self.num_buffers
            settle_count = self.settle_count

        t_sweep_start = time.perf_counter()
        freqs, qt_rx, qt_tx = self._build_sweep_grid(start, stop, step)
        grid_ms = (time.perf_counter() - t_sweep_start) * 1e3

        h_cal, _, timing = self._sweep_core(freqs, qt_rx, qt_tx, num_buffers, settle_count)
        if timing is not None:
            timing['grid_build_ms'] = round(grid_ms, 3)
            timing['sweep_total_ms'] = round((time.perf_counter() - t_sweep_start) * 1e3, 3)
        return h_cal, timing

    def _sweep_core(self, freqs, qt_rx, qt_tx, num_buffers, settle_count, progress_cb=None):
        """Sweep loop: retune, settle, capture num_buffers buffers and average them
        (noise averaging — 10*log10(num_buffers) dB of SNR for free), reference-divide.

        settle_count is the number of RX buffer arrivals to wait, after issuing a
        retune, before trusting the data — see CLAUDE.md's Sweep Timing / quick-tune
        regression note for why this matters and shouldn't be dropped carelessly.

        Every step is timed and broken into four phases (tune command -> ACK, settle
        wait, buffer receive, noise-averaging math) plus whatever Python overhead is
        left over; see _phase_stats/_log_timing for how they're summarised.

        Returns (h_cal, dropped_steps, timing) or (None, 0, None) if stopped.
        """
        num_steps = len(freqs)
        h_signal = np.zeros(num_steps, dtype=np.complex128)
        h_reference = np.zeros(num_steps, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)
        rx_ch = bladerf.CHANNEL_RX(0)

        use_qt = qt_rx is not None
        ref_tone_scaled = self._ref_tone_scaled
        rx_cond = self._rx_cond
        stop_event = self._stop_event

        dropped_steps = 0
        retune_failures = 0

        # Verbose per-packet detail only for these steps; every step still gets
        # a one-line summary with each transaction's time.
        log_steps = ({0, 1, 2, 3, 50, 150, num_steps // 2, num_steps - 1}
                     if _TIMING_LOG else frozenset())
        total_wait = settle_count + num_buffers

        def buf_bytes():
            """Actual size of one RX callback's payload, per channel.

            Do NOT hardcode this. bladerf_sync_rx() counts *interleaved* samples on
            RX_X2 (sync.c: samples_per_ts = 2), so a request for N returns N/2 per
            channel -- half what the driver's buffer sizing assumes. Reading the real
            array keeps the log honest about what actually arrived.
            """
            latest = self._rx_latest
            return latest[0].nbytes if latest is not None else 0

        t_tune_ms = []
        t_settle_ms = []
        t_bufs_ms = []
        t_noise_ms = []
        t_other_ms = []
        t_step_ms = []

        t_core_start = time.perf_counter()

        for i in range(num_steps):
            if stop_event.is_set():
                return None, 0, None

            t_step_start = time.perf_counter()
            verbose = i in log_steps

            f = int(freqs[i])
            # libbladeRF's retune/set_frequency calls are synchronous: they return
            # only once the NIOS has acknowledged the command, so each span below is
            # a real "tune command sent -> ACK received" time.
            if verbose:
                _log_timing(f"  Step {i:3d} >>> RX retune CMD SENT", freq=f"{f/1e9:.3f}GHz")
            t_rx_cmd = time.perf_counter()
            if use_qt:
                rc_rx = libbladeRF.bladerf_schedule_retune(dev_ptr, rx_ch, 0, f, qt_rx[i])
            else:
                rc_rx = libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, f)
            t_rx_ack = time.perf_counter()
            if verbose:
                _log_timing(f"  Step {i:3d} <<< RX retune ACK RECEIVED",
                            took=_format_duration(t_rx_ack - t_rx_cmd))
                _log_timing(f"  Step {i:3d} >>> TX retune CMD SENT")
            if use_qt:
                rc_tx = libbladeRF.bladerf_schedule_retune(dev_ptr, tx_ch, 0, f, qt_tx[i])
            else:
                rc_tx = libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, f)
            t_tuned = time.perf_counter()
            if verbose:
                _log_timing(f"  Step {i:3d} <<< TX retune ACK RECEIVED",
                            took=_format_duration(t_tuned - t_rx_ack))

            if rc_rx != 0 or rc_tx != 0:
                # Always logged, every step: that step's data is at the WRONG
                # frequency (the Nios rejected the retune, e.g. full queue).
                retune_failures += 1
                _log_timing(f"  Step {i:3d} *** RETUNE FAILED",
                            freq=f"{f/1e9:.3f}GHz", rx_rc=rc_rx, tx_rc=rc_tx,
                            note="step_data_captured_at_previous_frequency")

            # bladeRF streams continuously on EP0x81 — the Pi sends nothing here,
            # it just counts arrivals.
            if verbose:
                _log_timing(f"  Step {i:3d} ... Pi WAITING (no USB sent)",
                            waiting_for=f"{settle_count}_buffers_on_EP0x81",
                            note="bladeRF_streaming_continuously_Pi_just_counts")
            last_pkt_time = t_tuned
            pkt_num = 1

            with rx_cond:
                target_seq = self._rx_seq + settle_count
                while self._rx_seq < target_seq:
                    if not rx_cond.wait(timeout=1.0):
                        break
                    if verbose and self._rx_seq <= target_seq:
                        now = time.perf_counter()
                        _log_timing(f"  Step {i:3d}      Pi<<<bladeRF [EP0x81] pkt {pkt_num:2d}/{total_wait}",
                                    type="SETTLE(discard)", size=f"{buf_bytes()}B",
                                    dt=_format_duration(now - last_pkt_time))
                        last_pkt_time = now
                        pkt_num += 1
                t_settled = time.perf_counter()

                if verbose:
                    _log_timing(f"  Step {i:3d}      SETTLE DONE ({settle_count} buffers discarded)",
                                time=_format_duration(t_settled - t_tuned))
                    _log_timing(f"  Step {i:3d}      NOW KEEPING next {num_buffers} buffers from EP0x81",
                                note="noise_averaging")

                sig_bufs = []
                ref_bufs = []
                last_seq = self._rx_seq
                for buf_idx in range(num_buffers):
                    while self._rx_seq <= last_seq:
                        if not rx_cond.wait(timeout=1.0):
                            break
                    if self._rx_seq <= last_seq:
                        break
                    last_seq = self._rx_seq
                    sig_bufs.append(self._rx_latest[0])
                    ref_bufs.append(self._rx_latest[1])

                    if verbose:
                        now = time.perf_counter()
                        _log_timing(f"  Step {i:3d}      Pi<<<bladeRF [EP0x81] pkt {pkt_num:2d}/{total_wait}",
                                    type="CAPTURE(keep)", buf=f"{buf_idx+1}/{num_buffers}",
                                    size=f"{buf_bytes()}B",
                                    dt=_format_duration(now - last_pkt_time))
                        last_pkt_time = now
                        pkt_num += 1

            t_received = time.perf_counter()

            if verbose:
                _log_timing(f"  Step {i:3d}      ALL {len(sig_bufs)}/{total_wait} EP0x81 BUFFERS DONE",
                            total_time=_format_duration(t_received - t_tuned),
                            data=f"{len(sig_bufs)*buf_bytes()}B_kept_from_bladeRF")
                _log_timing(f"  Step {i:3d} ... PROCESSING (Pi CPU)",
                            operation="extract_IQ_via_ref_tone_mixing",
                            num_buffers=len(sig_bufs), note="no_USB_here")

            if sig_bufs:
                sig_arr = np.asarray(sig_bufs, dtype=np.float64)
                ref_arr = np.asarray(ref_bufs, dtype=np.float64)
                sig_cplx = (sig_arr[:, 0::2] + 1j * sig_arr[:, 1::2]) * ref_tone_scaled
                ref_cplx = (ref_arr[:, 0::2] + 1j * ref_arr[:, 1::2]) * ref_tone_scaled
                h_signal[i] = sig_cplx.mean()
                h_reference[i] = ref_cplx.mean()
            else:
                dropped_steps += 1

            t_averaged = time.perf_counter()

            if progress_cb and i % 10 == 0:
                progress_cb(i)

            t_step_end = time.perf_counter()

            tune = (t_tuned - t_step_start) * 1e3
            settle = (t_settled - t_tuned) * 1e3
            bufs = (t_received - t_settled) * 1e3
            noise = (t_averaged - t_received) * 1e3
            step = (t_step_end - t_step_start) * 1e3
            t_tune_ms.append(tune)
            t_settle_ms.append(settle)
            t_bufs_ms.append(bufs)
            t_noise_ms.append(noise)
            t_other_ms.append(step - tune - settle - bufs - noise)
            t_step_ms.append(step)

            # One line for EVERY step: each transaction's time as this step
            # experienced it.
            _log_timing(f"  Step {i:3d} {f/1e9:.3f}GHz",
                        ok="yes" if sig_bufs else "NO_DATA",
                        retune_rx=_format_duration((t_rx_ack - t_rx_cmd)),
                        retune_tx=_format_duration((t_tuned - t_rx_ack)),
                        settle=_format_duration(settle / 1e3),
                        capture=_format_duration(bufs / 1e3),
                        compute=_format_duration(noise / 1e3),
                        total=_format_duration(step / 1e3))

            if verbose:
                _log_timing(f"  Step {i:3d}     USB summary: 2x Retune OUT(16B)+ACK(16B) "
                            f"+ {pkt_num - 1}x Bulk IN({buf_bytes()}B)")
                if i < num_steps - 1:
                    print(flush=True)

        _log_separator('─')
        _log_timing("REF DIVISION START", valid_steps=f"{num_steps-dropped_steps}/{num_steps}")
        t_ref_start = time.perf_counter()
        ref_mag = np.abs(h_reference)
        valid = ref_mag > 1e-10
        h_cal = np.zeros(num_steps, dtype=np.complex128)
        h_cal[valid] = h_signal[valid] / h_reference[valid]
        t_ref_end = time.perf_counter()
        _log_timing("REF DIVISION DONE", time=_format_duration(t_ref_end - t_ref_start))

        if retune_failures > 0:
            _log_timing("*** SWEEP HAD RETUNE FAILURES",
                        failed_steps=f"{retune_failures}/{num_steps}",
                        note="those_steps_captured_at_wrong_frequency")

        timing = {
            'num_steps': num_steps,
            'num_buffers': num_buffers,
            'settle_count': settle_count,
            'dropped_steps': dropped_steps,
            'retune_failures': retune_failures,
            'per_step_ms': {
                'tune_ack': self._phase_stats(t_tune_ms),
                'settle': self._phase_stats(t_settle_ms),
                'buffers': self._phase_stats(t_bufs_ms),
                'noise_avg': self._phase_stats(t_noise_ms),
                'other': self._phase_stats(t_other_ms),
                'step_total': self._phase_stats(t_step_ms),
            },
            'ref_divide_ms': round((t_ref_end - t_ref_start) * 1e3, 3),
            'steps_total_ms': round((t_ref_start - t_core_start) * 1e3, 3),
            'sweep_core_ms': round((t_ref_end - t_core_start) * 1e3, 3),
        }

        return h_cal, dropped_steps, timing

    @staticmethod
    def _merge_timings(timings):
        """Combine the timing blocks of an averaged capture into one aggregate.

        Phase totals add across sub-sweeps; the per-step mean is re-derived from the
        summed totals and step counts, and min/max are the extremes seen anywhere.
        """
        if not timings:
            return None
        if len(timings) == 1:
            return timings[0]

        merged = dict(timings[0])
        steps = sum(t['num_steps'] for t in timings)
        per_step = {}
        for key in timings[0]['per_step_ms']:
            total = sum(t['per_step_ms'][key]['total'] for t in timings)
            per_step[key] = {
                'total': round(total, 3),
                'mean': round(total / steps, 3) if steps else 0.0,
                'min': round(min(t['per_step_ms'][key]['min'] for t in timings), 3),
                'max': round(max(t['per_step_ms'][key]['max'] for t in timings), 3),
            }
        merged['per_step_ms'] = per_step
        merged['dropped_steps'] = sum(t['dropped_steps'] for t in timings)
        merged['retune_failures'] = sum(t.get('retune_failures', 0) for t in timings)
        merged['ref_divide_ms'] = round(sum(t['ref_divide_ms'] for t in timings), 3)
        merged['steps_total_ms'] = round(sum(t['steps_total_ms'] for t in timings), 3)
        merged['sweep_core_ms'] = round(sum(t['sweep_core_ms'] for t in timings), 3)
        merged['grid_build_ms'] = round(sum(t.get('grid_build_ms', 0.0) for t in timings), 3)
        return merged

    @staticmethod
    def _phase_stats(samples):
        """total/mean/min/max in ms for one per-step timing phase."""
        if not samples:
            return {'total': 0.0, 'mean': 0.0, 'min': 0.0, 'max': 0.0}
        return {
            'total': round(float(np.sum(samples)), 3),
            'mean': round(float(np.mean(samples)), 3),
            'min': round(float(np.min(samples)), 3),
            'max': round(float(np.max(samples)), 3),
        }

    def _log_sweep_summary(self, timing, label='SWEEP'):
        """Per-phase totals for the whole sweep, in the same log format as the steps."""
        if not timing:
            return
        ps = timing['per_step_ms']
        total_ms = timing.get('sweep_total_ms', timing.get('sweep_core_ms', 0.0))
        rate = (1000.0 / total_ms) if total_ms > 0 else float('inf')

        def trio(key):
            s = ps[key]
            return (f"{_format_duration(s['mean']/1e3)}/{_format_duration(s['min']/1e3)}"
                    f"/{_format_duration(s['max']/1e3)}")

        _log_separator('─')
        header = {'steps': timing['num_steps'],
                  'buffers': timing['num_buffers'],
                  'settle': timing['settle_count']}
        if timing.get('sweeps_averaged'):
            header['averaged_over'] = f"{timing['sweeps_averaged']}_sweeps"
        if timing.get('dropped_steps'):
            header['incomplete_steps'] = timing['dropped_steps']
        if timing.get('retune_failures'):
            header['retune_failures'] = timing['retune_failures']
        _log_timing(f"{label} TIMING", **header)
        _log_timing("  per-step mean/min/max",
                    retune=trio('tune_ack'), settle=trio('settle'),
                    capture=trio('buffers'), compute=trio('noise_avg'),
                    other=trio('other'), step_total=trio('step_total'))
        _log_timing("  phase totals",
                    retune=_format_duration(ps['tune_ack']['total'] / 1e3),
                    settle=_format_duration(ps['settle']['total'] / 1e3),
                    capture=_format_duration(ps['buffers']['total'] / 1e3),
                    compute=_format_duration(ps['noise_avg']['total'] / 1e3),
                    other=_format_duration(ps['other']['total'] / 1e3),
                    all_steps=_format_duration(timing['steps_total_ms'] / 1e3))
        _log_timing("  sweep overhead",
                    grid=_format_duration(timing.get('grid_build_ms', 0.0) / 1e3),
                    ref_div=_format_duration(timing['ref_divide_ms'] / 1e3),
                    postproc=_format_duration(timing.get('process_ms', 0.0) / 1e3))
        _log_timing(f"  {label} TOTAL",
                    time=_format_duration(total_ms / 1e3), rate=f"{rate:.2f}Hz")

    def _process_h_cal(self, h_cal):
        num_steps = len(h_cal)
        start = self.start_freq
        stop = self.stop_freq
        step = self.step_size

        phase_raw = np.angle(h_cal)
        phase_unwrapped = np.unwrap(phase_raw)
        coeffs = np.polyfit(np.arange(num_steps), phase_unwrapped, 1)
        residuals = phase_unwrapped - np.polyval(coeffs, np.arange(num_steps))
        phase_std = float(np.std(residuals))

        window = np.hanning(num_steps)
        h_windowed = h_cal * window
        nfft = num_steps * 4
        range_profile = np.fft.ifft(h_windowed, n=nfft)
        magnitude_db = 20 * np.log10(np.abs(range_profile) + 1e-12)

        max_range = SPEED_OF_LIGHT / (2 * step)
        distances = np.arange(nfft) / nfft * max_range - self.range_offset

        half = nfft // 2
        magnitude_db = magnitude_db[:half]
        distances = distances[:half]

        valid = distances >= 0
        distances = distances[valid]
        magnitude_db = magnitude_db[valid]

        h_cal_real = h_cal.real.tolist()
        h_cal_imag = h_cal.imag.tolist()

        return {
            'type': 'range_profile',
            'distances': distances.tolist(),
            'magnitudes': magnitude_db.tolist(),
            'h_cal_real': [round(v, 8) for v in h_cal_real],
            'h_cal_imag': [round(v, 8) for v in h_cal_imag],
            'range_resolution': SPEED_OF_LIGHT / (2 * (stop - start)),
            'unambiguous_range': max_range,
            'displayed_range_max': max_range / 2 - self.range_offset,
            'num_steps': num_steps,
            'step_size': step,
            # The true swept frequency axis, so the groundstation never has to
            # guess it from step_size alone (the Imaging Bench's dispersion and
            # raw-S21 views need the actual RF frequencies). stop_freq is the
            # last frequency actually visited, which equals self.stop_freq only
            # when the step divides the span evenly.
            'start_freq': int(start),
            'stop_freq': int(start + (num_steps - 1) * step),
            'range_offset': self.range_offset,
            'timestamp': time.time(),
            'phase_coherence': {
                'phase_std_rad': phase_std,
                'phase_std_deg': float(np.degrees(phase_std)),
                'coherent': phase_std < 0.3,
                'slope_rad_per_step': float(coeffs[0]),
            },
        }
