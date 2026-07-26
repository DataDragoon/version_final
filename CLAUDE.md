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
SFCW AGC: Characterization-based gain profile (not runtime AGC).
  Iterative characterization (5-pass max) measures actual magnitude at each freq step, refines TX+RX1 gains.
  Profile saved to pi/calibration/gain_profile.npz — loads on startup, ~18s sweep (vs 100s first-time characterization).
  TX1=TX2 gain-tracking + digital attenuation on TX2 (0.05 scale) to prevent cable saturation.
  Same analog gain register on both TX channels → identical phase response → cancels in signal/reference division.
  TX gain varied per-step for real SNR improvement (39-66 dB); RX1 also adjustable (17-58 dB) for fine-tuning.
  Only RX1 gain changes need post-compensation (TX cancels). RX2=30 fixed for reference channel.
  Key insight: AD9361 gain vs frequency is highly non-linear — must measure empirically, not assume dB linearity.
  Recharacterize via WebSocket cmd 'sfcw_recharacterize', or auto-triggers on freq param changes.
FMCW engine uses chirp TX with matched-filter processing gain (28.7 dB over CW); same stepped-freq IFFT for range.
Next steps: OptiFlow pipeline, SAR reconstruction integration.
