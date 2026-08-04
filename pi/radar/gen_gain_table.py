"""Generate gain table: wall-present, attenuator on ref, no headroom.

Algorithm per frequency:
  1. Ramp TX 25->66 until RX1 >= 0.9 (coupling + wall reflection)
  2. If TX maxed, ramp RX 26->60 until RX1 >= 0.9
  3. Back off TX if overshoot (>0.90)
  4. Step down scale from 1.0 by 0.05 until RX2 <= 0.9
  5. Measure phase stability (20 captures)

Usage:
  python3 -u pi/radar/gen_gain_table.py              # full 1-6 GHz
  python3 -u pi/radar/gen_gain_table.py 2000 3000    # only 2-3 GHz (updates those slots)
"""
import sys
import time
import threading
import numpy as np

sys.path.insert(0, '/home/sfr/version0/pi/radar')

from bladerf._bladerf import libbladeRF, ffi
import bladerf
from bladerf_driver import BladeRFDriver
from sfcw_engine import SFCWEngine
import os

# Full table grid (always 501 entries, 1-6 GHz, 10 MHz steps)
FULL_START = 1_000_000_000
FULL_STOP = 6_000_000_000
STEP = 10_000_000
FULL_NUM = int((FULL_STOP - FULL_START) / STEP) + 1
FULL_FREQS = np.linspace(FULL_START, FULL_STOP, FULL_NUM).astype(np.int64)

# Run range from args (defaults to full)
RUN_START = int(sys.argv[1]) * 1_000_000 if len(sys.argv) > 1 else FULL_START
RUN_STOP = int(sys.argv[2]) * 1_000_000 if len(sys.argv) > 2 else FULL_STOP

RX1_TARGET = 0.9
RX1_OVERSHOOT = 0.90

CALIBRATION_DIR = '/home/sfr/version0/pi/calibration'
GAIN_TABLE_PATH = os.path.join(CALIBRATION_DIR, 'gain_table.npz')


def load_or_create_table():
    """Load existing table or create empty one with full 501-entry grid."""
    if os.path.exists(GAIN_TABLE_PATH):
        npz = np.load(GAIN_TABLE_PATH)
        if len(npz['freq_hz']) == FULL_NUM:
            return {
                'freq_hz': npz['freq_hz'].copy(),
                'tx_gain': npz['tx_gain'].copy(),
                'rx_gain': npz['rx_gain'].copy(),
                'tx2_scale': npz['tx2_scale'].copy(),
                'phase_std_deg': npz['phase_std_deg'].copy(),
            }
    # Create fresh
    return {
        'freq_hz': FULL_FREQS.copy(),
        'tx_gain': np.zeros(FULL_NUM, dtype=int),
        'rx_gain': np.zeros(FULL_NUM, dtype=int),
        'tx2_scale': np.ones(FULL_NUM, dtype=np.float64),
        'phase_std_deg': np.zeros(FULL_NUM, dtype=np.float64),
    }


def main():
    # Find indices into full table for the run range
    idx_start = int(np.argmin(np.abs(FULL_FREQS - RUN_START)))
    idx_stop = int(np.argmin(np.abs(FULL_FREQS - RUN_STOP)))
    run_indices = list(range(idx_start, idx_stop + 1))
    num_run = len(run_indices)

    print("=" * 70)
    print(f"GAIN TABLE — updating {num_run} entries, {RUN_START/1e9:.1f}-{RUN_STOP/1e9:.1f} GHz")
    print(f"RX1 target={RX1_TARGET}, wall present, attenuator on ref cable")
    print("=" * 70)

    table = load_or_create_table()

    driver = BladeRFDriver()
    driver.open()
    print(f"[hw] bladeRF: {driver.serial}")

    engine = SFCWEngine(driver)

    engine.driver.set_waveform('cw', offset=100_000, amplitude=0.9)
    engine.driver._configure_channels_dual()

    engine._rx_latest = (None, None)
    engine._rx_event = threading.Event()
    n = 1024
    t = np.arange(n, dtype=np.float64) / engine.driver.sample_rate
    engine._ref_tone = np.exp(-1j * 2 * np.pi * engine.driver.cw_offset * t)

    engine.driver.start_tx_dual(tx2_digital_scale=1.0)
    engine.driver.start_rx_dual(engine._rx_capture, num_samples=n)
    time.sleep(0.2)

    dev_ptr = engine.driver.device.dev[0]
    tx_ch0 = bladerf.CHANNEL_TX(0)
    tx_ch1 = bladerf.CHANNEL_TX(1)
    rx_ch0 = bladerf.CHANNEL_RX(0)
    rx_ch1 = bladerf.CHANNEL_RX(1)

    libbladeRF.bladerf_set_gain_mode(dev_ptr, rx_ch0, libbladeRF.BLADERF_GAIN_MGC)
    libbladeRF.bladerf_set_gain_mode(dev_ptr, rx_ch1, libbladeRF.BLADERF_GAIN_MGC)

    # One-shot cal before generation (tracking stays disabled from open())
    engine.driver.run_oneshot_calibration()

    t_start = time.time()
    problems = 0

    print(f"\n{'#':<5} {'Freq':<8} {'TX':<5} {'RX':<5} {'Scale':<8} {'RX1':<7} {'RX2':<7} {'Phase':<8} {'Status'}")
    print("-" * 72)

    for count, idx in enumerate(run_indices):
        freq = int(FULL_FREQS[idx])
        libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch0, freq)
        libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch0, freq)
        time.sleep(0.05)

        # Step 1: Ramp TX 25->66 until RX1 >= target
        tx_g = 25
        rx_g = 25
        libbladeRF.bladerf_set_gain(dev_ptr, rx_ch0, rx_g)
        libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, rx_g)
        engine.driver._tx2_digital_scale = 1.0

        best_tx = 25
        best_rx = 25
        rx1_mag = 0.0

        while tx_g <= 66:
            libbladeRF.bladerf_set_gain(dev_ptr, tx_ch0, tx_g)
            libbladeRF.bladerf_set_gain(dev_ptr, tx_ch1, tx_g)
            time.sleep(0.05)
            _, _, rx1_peak, _ = engine._measure_step(4)
            rx1_mag = rx1_peak
            if rx1_mag >= RX1_TARGET:
                best_tx = tx_g
                break
            tx_g += 1
        else:
            best_tx = 66

        # Step 2: If TX maxed and RX1 < target, ramp RX
        if rx1_mag < RX1_TARGET and best_tx >= 66:
            rx_g = 26
            while rx_g <= 60:
                libbladeRF.bladerf_set_gain(dev_ptr, rx_ch0, rx_g)
                libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, rx_g)
                time.sleep(0.05)
                _, _, rx1_peak, _ = engine._measure_step(4)
                rx1_mag = rx1_peak
                if rx1_mag >= RX1_TARGET:
                    best_rx = rx_g
                    break
                rx_g += 1
            else:
                best_rx = 60

        # Step 3: Back off TX if overshooting
        if rx1_mag > RX1_OVERSHOOT and best_tx > 25:
            while best_tx > 25 and rx1_mag > RX1_OVERSHOOT:
                best_tx -= 1
                libbladeRF.bladerf_set_gain(dev_ptr, tx_ch0, best_tx)
                libbladeRF.bladerf_set_gain(dev_ptr, tx_ch1, best_tx)
                time.sleep(0.05)
                _, _, rx1_peak, _ = engine._measure_step(4)
                rx1_mag = rx1_peak

        # Ensure final gains
        libbladeRF.bladerf_set_gain(dev_ptr, tx_ch0, best_tx)
        libbladeRF.bladerf_set_gain(dev_ptr, tx_ch1, best_tx)
        libbladeRF.bladerf_set_gain(dev_ptr, rx_ch0, best_rx)
        libbladeRF.bladerf_set_gain(dev_ptr, rx_ch1, best_rx)
        time.sleep(0.05)

        # Step 4: Decrease scale until RX2 stops clipping
        best_scale = 1.0
        engine.driver._tx2_digital_scale = best_scale
        time.sleep(0.05)
        _, _, _, rx2_peak = engine._measure_step(4)

        while rx2_peak > 0.9 and best_scale > 0.05:
            best_scale -= 0.05
            engine.driver._tx2_digital_scale = best_scale
            time.sleep(0.05)
            _, _, _, rx2_peak = engine._measure_step(4)

        engine.driver._tx2_digital_scale = best_scale
        time.sleep(0.05)

        # Step 5: Measure phase stability (20 captures)
        phases = []
        for _ in range(20):
            engine._rx_event.clear()
            engine._rx_event.wait(timeout=1.0)
            sig, ref, _, _ = engine._measure_step(2)
            if abs(ref) > 1e-10:
                phases.append(np.angle(sig / ref))
        phase_std = float(np.degrees(np.std(phases))) if len(phases) >= 2 else 999.0

        # Final magnitude check
        _, _, rx1_final, rx2_final = engine._measure_step(4)

        # Update table
        table['tx_gain'][idx] = best_tx
        table['rx_gain'][idx] = best_rx
        table['tx2_scale'][idx] = best_scale
        table['phase_std_deg'][idx] = phase_std

        # Status
        status = "OK"
        if rx1_final > 0.98:
            status = "CLIP!"
            problems += 1
        elif rx1_final < 0.6:
            status = "LOW"
            problems += 1
        elif phase_std > 5.0:
            status = "PHASE"
            problems += 1
        elif best_scale <= 0.05:
            status = "FLOOR"
            problems += 1

        elapsed = time.time() - t_start
        eta = (elapsed / (count + 1)) * (num_run - count - 1)
        print(f"{count+1:<5} {freq/1e6:<8.0f} {best_tx:<5} {best_rx:<5} {best_scale:<8.4f} {rx1_final:<7.3f} {rx2_final:<7.3f} {phase_std:<8.2f} {status}  [{elapsed:.0f}s / ETA {eta:.0f}s]")

    # Save full table
    os.makedirs(CALIBRATION_DIR, exist_ok=True)
    np.savez(GAIN_TABLE_PATH,
             freq_hz=table['freq_hz'],
             tx_gain=table['tx_gain'],
             rx_gain=table['rx_gain'],
             tx2_scale=table['tx2_scale'],
             phase_std_deg=table['phase_std_deg'])

    elapsed = time.time() - t_start
    print(f"\n{'=' * 70}")
    print(f"DONE in {elapsed:.1f}s — updated {num_run} entries")
    print(f"  Run range: {RUN_START/1e6:.0f}-{RUN_STOP/1e6:.0f} MHz")
    print(f"  TX range: [{table['tx_gain'][run_indices].min()}, {table['tx_gain'][run_indices].max()}]")
    print(f"  RX range: [{table['rx_gain'][run_indices].min()}, {table['rx_gain'][run_indices].max()}]")
    print(f"  Scale range: [{table['tx2_scale'][run_indices].min():.4f}, {table['tx2_scale'][run_indices].max():.4f}]")
    print(f"  Phase std median: {np.median(table['phase_std_deg'][run_indices]):.2f}°")
    print(f"  Phase std > 5°: {np.sum(table['phase_std_deg'][run_indices] > 5)}")
    print(f"  Problems: {problems}")
    print(f"  Saved: {GAIN_TABLE_PATH}")
    print(f"{'=' * 70}")

    driver.close()


if __name__ == '__main__':
    main()
