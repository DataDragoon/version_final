# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

SFCW radar for through-wall imaging. See CONTEXT.md for full system description.

## Key Facts

- This repo runs on TWO machines: Raspberry Pi (pi/) and PC (groundstation/)
- Clone the repo on both; run the appropriate code on each
- Pi never receives direct user input — all control via groundstation over LAN
- Heavy compute (SAR reconstruction, ML) belongs on the PC side
- Every subsystem must have a corresponding debug tool on groundstation

## Code Conventions

- Python for all Pi code (sensor drivers, radar control, networking)
- Python or TypeScript for groundstation (TBD based on UI framework choice)
- Shared protocol definitions in shared/protocols/
- Keep sensor interfaces minimal and async-friendly
- Prefer ZeroMQ or similar for IPC once protocol is chosen

## Hardware Context

- Raspberry Pi with AI HAT+ (Hailo-8L accelerator)
- Camera: Pi NoIR v3 (CSI, use libcamera/picamera2)
- LiDAR: TF-LC02 (UART, 115200 baud default)
- IMU: MPU-6500 (I2C, address 0x68)
- SDR: bladeRF (USB, use libbladeRF / pybladeRF)
- Antennas: 2x Vivaldi (wideband, one TX one RX)

## Living Documentation Rule

CLAUDE.md and CONTEXT.md are living documents. Whenever you learn key information
worth persisting — new design decisions, hardware findings, protocol choices,
calibration values, architectural changes, or anything a future session would
need to know — update CLAUDE.md and/or CONTEXT.md immediately. Don't wait to be
asked. These files are how context survives across sessions and collaborators.

## Current Phase

IMU, LiDAR, Camera, and bladeRF SDR integrated. All stream to groundstation debug panels.
RF Calib panel provides signal generator + oscilloscope for bladeRF calibration (TX1/RX1).
SFCW panel performs stepped-frequency sweeps (1–6 GHz default) with range profile + waterfall display.
Both RF panels share port 9003 — starting an SFCW sweep auto-stops any active TX/RX in RF Calib.
Pi-side architecture: bladerf_driver.py (HAL) → sfcw_engine.py / fmcw_engine.py (sweep logic) → sdr_server.py (WebSocket).
SFCW Gain: Per-frequency lookup table (no runtime AGC, no iterative characterization).
  Table generated once via 'sfcw_generate_table' WebSocket cmd — tunes each freq independently (1-6 GHz, 10 MHz steps, 501 entries).
  Per entry: tx_gain, rx_gain, tx2_scale, phase_std_deg. Stored at pi/calibration/gain_table.npz.
  TX1=TX2 gain (same register) — phase cancels in signal/reference division.
  RX1=RX2 gain (same register) — phase cancels in signal/reference division.
  TX2 digital scale prevents cable saturation (binary-searched to land RX2 at ~0.9).
  Algorithm: ramp TX 25→66, then RX 25→60 until RX1≈0.9; back off if overshoot.
  During sweep, table lookup replaces per-step gain — no AGC, no compensation needed.
  Verify via 'sfcw_verify_table' cmd. Reload via 'sfcw_reload_table'.
  Key insight: AD9361 gain vs frequency is highly non-linear — must measure empirically.
FMCW engine uses chirp TX with matched-filter processing gain (28.7 dB over CW); same stepped-freq IFFT for range.
Next steps: OptiFlow pipeline, SAR reconstruction integration.
