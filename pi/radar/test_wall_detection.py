#!/usr/bin/env python3
"""Test script: verify SFCW wall detection.

Run on the Pi with the antenna pointing at a wall ~42cm away.
Stops the sdr_server first (only one process can hold the bladeRF USB).

Usage: python3 -u test_wall_detection.py
"""

import sys
import os
import time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bladerf_driver import BladeRFDriver
from sfcw_engine import SFCWEngine, SPEED_OF_LIGHT

def main():
    print("=== SFCW Wall Detection Test ===")
    print(f"Expected: wall at ~42 cm physical distance")
    print(f"Cable: 10 cm SMA (subtracts ~7 cm from apparent range)")
    print()

    driver = BladeRFDriver()
    driver.open()
    engine = SFCWEngine(driver)

    # Use defaults from engine (1-2.38 GHz, 10 MHz steps, 139 points)
    print(f"Sweep: {engine.start_freq/1e6:.0f}-{engine.stop_freq/1e6:.0f} MHz, "
          f"{engine.step_size/1e6:.0f} MHz steps, {engine.num_steps} points")
    print(f"Range resolution: {engine.range_resolution*100:.1f} cm")
    print(f"Max unambiguous range: {engine.max_range:.1f} m")
    print(f"Range offset: {engine.range_offset:.3f} m")
    print(f"Blank range: {engine.blank_range:.2f} m")
    print(f"Gain table loaded: {engine._gain_table is not None}")
    print()

    results = []

    def on_result(data):
        if data.get('type') == 'range_profile':
            results.append(data)
        elif data.get('type') == 'progress':
            pass

    # Run 5 sweeps to test consistency
    num_sweeps = 5
    print(f"Running {num_sweeps} sweeps...")

    for sweep_idx in range(num_sweeps):
        engine._h_avg_accum = None
        engine._h_avg_count = 0
        engine.run_single(on_result)

        # Wait for completion
        timeout = 30
        t0 = time.time()
        while engine.running and (time.time() - t0) < timeout:
            time.sleep(0.1)

        if engine.running:
            engine.stop()
            print(f"  Sweep {sweep_idx+1}: TIMEOUT")
            continue

        if results and results[-1].get('type') == 'range_profile':
            r = results[-1]
            peak = r['peak']
            phase = r['phase_coherence']
            print(f"  Sweep {sweep_idx+1}: peak at {peak['distance_m']*100:.1f} cm, "
                  f"SNR={peak['snr_db']:.1f} dB, "
                  f"phase_std={phase['phase_std_deg']:.1f}°")
        else:
            print(f"  Sweep {sweep_idx+1}: no result")

    print()

    if not results:
        print("ERROR: No results collected")
        driver.close()
        return

    # Analyze consistency
    peaks = [r['peak'] for r in results if r.get('type') == 'range_profile']
    if len(peaks) >= 2:
        distances = [p['distance_m'] for p in peaks]
        snrs = [p['snr_db'] for p in peaks]
        print(f"Peak distance: mean={np.mean(distances)*100:.1f} cm, "
              f"std={np.std(distances)*100:.1f} cm")
        print(f"Peak SNR: mean={np.mean(snrs):.1f} dB, "
              f"std={np.std(snrs):.1f} dB")
        print()
        if np.std(distances) < 0.02:
            print("PASS: Peak position stable (< 2 cm variation)")
        else:
            print("FAIL: Peak position unstable")

        if np.mean(snrs) > 15:
            print("PASS: Good SNR (> 15 dB)")
        elif np.mean(snrs) > 8:
            print("MARGINAL: Moderate SNR (8-15 dB)")
        else:
            print("FAIL: Low SNR (< 8 dB)")

    # Print full range profile from last sweep
    last = results[-1]
    dists = np.array(last['distances'])
    mags = np.array(last['magnitudes'])

    print()
    print("Range profile (last sweep):")
    print(f"  {'Range (cm)':>10} | {'Mag (dB)':>8}")
    print(f"  {'-'*10}-+-{'-'*8}")

    # Show every 5th bin for concise output
    step = max(1, len(dists) // 30)
    for i in range(0, len(dists), step):
        marker = " <--" if i == int(np.argmax(mags)) else ""
        print(f"  {dists[i]*100:10.1f} | {mags[i]:8.1f}{marker}")

    driver.close()
    print()
    print("Done.")


if __name__ == '__main__':
    main()
