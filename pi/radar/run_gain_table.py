"""One-shot script: generate gain table, verify it, run a full-band sweep."""

import sys
import time
import numpy as np

sys.path.insert(0, '/home/sfr/version0/pi/radar')

from bladerf_driver import BladeRFDriver
from sfcw_engine import SFCWEngine

SPEED_OF_LIGHT = 299_792_458


def main():
    print("=" * 60)
    print("SFCW Gain Table Generation + Verification")
    print("=" * 60)

    driver = BladeRFDriver()
    driver.open()
    print(f"[hw] bladeRF opened: {driver.serial}")

    engine = SFCWEngine(driver)

    # --- Step 1: Generate gain table ---
    print("\n" + "=" * 60)
    print("STEP 1: Generating gain table (1-6 GHz, 10 MHz steps, 501 entries)")
    print("=" * 60 + "\n")

    gen_result = {}

    def gen_callback(data):
        if data.get('type') == 'table_complete':
            gen_result.update(data)
        elif data.get('type') == 'error':
            print(f"[ERROR] {data['message']}")
            sys.exit(1)

    t0 = time.time()
    engine.generate_gain_table(callback=gen_callback)

    # Wait for completion
    while engine.running:
        time.sleep(1)

    elapsed = time.time() - t0
    print(f"\n[done] Table generation completed in {elapsed:.1f}s")
    if gen_result:
        print(f"  Entries: {gen_result.get('num_entries')}")
        print(f"  TX range: {gen_result.get('tx_range')}")
        print(f"  RX range: {gen_result.get('rx_range')}")
        print(f"  Phase std median: {gen_result.get('phase_std_median', 0):.1f}°")

    # --- Step 2: Verify gain table ---
    print("\n" + "=" * 60)
    print("STEP 2: Verifying gain table")
    print("=" * 60 + "\n")

    verify_result = {}

    def verify_callback(data):
        if data.get('type') == 'verify_complete':
            verify_result.update(data)
        elif data.get('type') == 'error':
            print(f"[ERROR] {data['message']}")

    t0 = time.time()
    engine.verify_gain_table(callback=verify_callback)

    while engine.running:
        time.sleep(1)

    elapsed = time.time() - t0
    print(f"\n[done] Verification completed in {elapsed:.1f}s")
    if verify_result:
        n = verify_result['num_entries']
        print(f"  Entries: {n}")
        print(f"  RX1 in [0.8, 0.95]: {verify_result['rx1_in_range']}/{n}")
        print(f"  RX2 in [0.8, 0.95]: {verify_result['rx2_in_range']}/{n}")
        print(f"  RX1 actual range: [{verify_result['rx1_range'][0]:.3f}, {verify_result['rx1_range'][1]:.3f}]")
        print(f"  RX2 actual range: [{verify_result['rx2_range'][0]:.3f}, {verify_result['rx2_range'][1]:.3f}]")
        print(f"  Phase std > 10°: {verify_result['high_phase_count']}")
        print(f"  Clipped entries: {verify_result['clipped_count']}")
        print(f"  Problem entries: {verify_result['problem_count']}")
        print(f"  Phase std median: {verify_result['phase_std_median']:.1f}°")

    # --- Step 3: Full-band SFCW sweep using the table ---
    print("\n" + "=" * 60)
    print("STEP 3: Full-band SFCW sweep (2-5 GHz, 20 MHz step)")
    print("=" * 60 + "\n")

    engine.set_params(start_freq=2_000_000_000, stop_freq=5_000_000_000, step_size=20_000_000)

    sweep_result = {}

    def sweep_callback(data):
        if data.get('type') == 'range_profile':
            sweep_result.update(data)
        elif data.get('type') == 'error':
            print(f"[ERROR] {data['message']}")

    t0 = time.time()
    engine.run_single(callback=sweep_callback)

    while engine.running:
        time.sleep(0.5)

    elapsed = time.time() - t0
    print(f"[done] Sweep completed in {elapsed:.1f}s")

    if sweep_result:
        magnitudes = np.array(sweep_result['magnitudes'])
        distances = np.array(sweep_result['distances'])

        # SNR: peak - noise floor (noise floor = median of bottom 50%)
        peak_db = float(np.max(magnitudes))
        sorted_mags = np.sort(magnitudes)
        noise_floor = float(np.median(sorted_mags[:len(sorted_mags)//2]))
        snr = peak_db - noise_floor

        # Phase coherence
        phase_info = sweep_result.get('phase_coherence', {})
        phase_std_deg = phase_info.get('phase_std_deg', 0)

        # Peak width at -6dB
        peak_idx = int(np.argmax(magnitudes))
        threshold = peak_db - 6.0
        above = magnitudes >= threshold
        # Count contiguous bins around peak
        left = peak_idx
        while left > 0 and above[left - 1]:
            left -= 1
        right = peak_idx
        while right < len(magnitudes) - 1 and above[right + 1]:
            right += 1
        peak_width_bins = right - left + 1

        print(f"\n  Range profile analysis:")
        print(f"    Peak: {peak_db:.1f} dB at {distances[peak_idx]:.2f} m")
        print(f"    Noise floor: {noise_floor:.1f} dB")
        print(f"    SNR: {snr:.1f} dB")
        print(f"    Phase std: {phase_std_deg:.1f}°")
        print(f"    Phase coherent: {phase_info.get('coherent', False)}")
        print(f"    -6dB peak width: {peak_width_bins} bins (ideal ~4 with Hanning)")
        print(f"    Num steps: {sweep_result['num_steps']}")
        print(f"    Range resolution: {sweep_result['range_resolution']*100:.1f} cm")

        # Check h_cal for any clipped steps (would show as anomalously large values)
        if 'h_cal_real' in sweep_result:
            h_real = np.array(sweep_result['h_cal_real'])
            h_imag = np.array(sweep_result['h_cal_imag'])
            h_mag = np.abs(h_real + 1j * h_imag)
            outliers = np.sum(h_mag > 10 * np.median(h_mag))
            print(f"    H(f) magnitude range: {h_mag.min():.4f} - {h_mag.max():.4f}")
            print(f"    H(f) outliers (>10x median): {outliers}")

    print("\n" + "=" * 60)
    print("COMPLETE")
    print("=" * 60)

    driver.close()


if __name__ == '__main__':
    main()
