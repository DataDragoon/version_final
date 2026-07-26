# version0 — SFCW Radar Wall Imaging System

## Mission

Through-wall imaging using a Stepped-Frequency Continuous Wave (SFCW) radar,
with OptiFlow-based positioning for coherent aperture synthesis.

---

## Hardware

| Component | Model | Interface | Role |
|-----------|-------|-----------|------|
| Compute | Raspberry Pi (with AI HAT+) | — | On-board control, sensor fusion, data capture |
| Camera | Raspberry Pi NoIR Camera v3 | CSI | Optical flow input (OptiFlow positioning) |
| LiDAR | TF-LC02 | UART (serial) | Range/distance reference |
| IMU | MPU-6500 | I2C | Orientation, acceleration, gyro |
| SDR | bladeRF | USB | SFCW radar TX/RX |
| Antennas | 2x Vivaldi | SMA to bladeRF | Wideband TX and RX |
| Network | Ethernet/WiFi | LAN | Pi <-> PC link |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        LAN                                   │
│                                                             │
│  ┌─────────────────────┐          ┌──────────────────────┐ │
│  │   Raspberry Pi       │          │   PC (Groundstation) │ │
│  │                     │          │                      │ │
│  │  - Sensor capture   │  ◄────►  │  - Control panel     │ │
│  │  - Radar TX/RX      │  socket  │  - Debug tools       │ │
│  │  - OptiFlow compute │          │  - Heavy processing  │ │
│  │  - Data streaming   │          │  - 3D visualization  │ │
│  └─────────────────────┘          └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Operational Model

- **No direct input to the Pi.** All commands originate from the groundstation.
- **Pi streams data** (raw IQ, sensor logs, camera frames) to groundstation.
- **Heavy processing** (image reconstruction, SAR focusing) runs on the PC.
- **Debug everything.** Every subsystem has a dedicated debug view on groundstation.

## Groundstation Debug Tools (planned)

- LiDAR distance log + live plot
- IMU orientation/accel live view
- Camera direct view (raw NoIR feed)
- OptiFlow vector field visualization
- OptiFlow-derived position (2D/3D)
- 3D position visualizer (fused estimate)
- Radar TX/RX pattern viewer
- Raw IQ waterfall / spectrogram
- SFCW range profile display
- SAR image reconstruction view
- System health / link status

## Groundstation Control Panel (planned)

- Initiate scan
- Stop / pause / resume
- Configure radar parameters (freq range, step size, dwell time)
- Configure sensor sampling rates
- Trigger calibration routines
- Data recording start/stop

## Directory Structure

```
version0/
├── pi/                    # Code that runs on the Raspberry Pi
│   ├── sensors/           # LiDAR, IMU, camera drivers/readers
│   ├── radar/             # bladeRF SFCW control
│   ├── optiflow/          # Optical flow positioning (AI HAT+)
│   ├── comms/             # Network transport to groundstation
│   └── scripts/           # Startup, calibration, utilities
├── groundstation/         # Code that runs on the PC
│   ├── ui/                # Main GUI framework
│   ├── debug/             # All debug/visualization tools
│   ├── control/           # Command panel (start/stop/config)
│   ├── processing/        # Heavy compute (SAR, image recon)
│   └── comms/             # Network transport to Pi
├── shared/                # Code used by both Pi and PC
│   ├── protocols/         # Message formats, command definitions
│   └── config/            # Shared configuration constants
├── docs/                  # Additional documentation
├── CONTEXT.md             # THIS FILE — project global context
└── CLAUDE.md              # Claude Code project instructions
```

## Network Protocol (TBD)

Communication between Pi and groundstation. Likely ZeroMQ or raw TCP sockets
with a simple framed binary protocol. Requirements:
- Low-latency command delivery (groundstation -> Pi)
- High-throughput data streaming (Pi -> groundstation)
- Multiplexed channels (IQ data, sensor data, camera, status)

## Radar Parameters

- Hardware: bladeRF xA9 (AD9361 RFIC)
- Frequency range: 1–3 GHz (configurable, max ~3.8 GHz)
- Step size: 10 MHz default
- Dwell time per step: 1 ms (PLL settle)
- TX power: 0.9 amplitude, gain 47 dB
- Antenna polarization: co-pol initially
- Phase coherence: Dual-channel reference method — TX2→RX2 short SMA cable
  provides phase reference. Signal (RX1) divided by reference (RX2) cancels
  random PLL phase offsets between TX and RX synthesizers at each step.
  AD9361 single-synth mode does NOT work (FDD requires both PLLs active).

### Modes

- **SFCW** (sfcw_engine.py): CW tone per step, one complex H(f) value per step,
  IFFT across steps → range profile. Resolution = c/(2*BW) where BW = stop-start.
  Has per-frequency gain management via calibrated gain table.
- **Chirp/FMCW** (fmcw_engine.py): 15 MHz chirp at each step center, matched-filter
  processing (de-chirp + coherent sum = pulse compression). Gives BW*T = 750 (28.7 dB)
  processing gain over CW. Same stepped-frequency IFFT for range profile.
  At current params (15 MHz chirp, 50μs, <10m range), beat freq ~3.6 kHz falls in DC
  FFT bin — no intra-chirp range resolution. True FMCW benefit requires >80 MHz chirp BW
  or >5ms chirp duration (neither feasible with AD9361 at 20 MSPS).
  Chirp value: SNR gain, better chirp-boundary timing, narrowband interference rejection.

## Wiring — MPU-6500 (I2C mode)

| MPU-6500 Pin | Raspberry Pi | Notes |
|---|---|---|
| VIN | Pin 2 (5V) | Powers onboard regulator |
| 3V3 | NC | Regulator output, leave unconnected |
| GND | Pin 6 (GND) | Common ground |
| SCL | Pin 5 (GPIO 3) | I2C1 clock |
| SDA | Pin 3 (GPIO 2) | I2C1 data |
| SDD/SAO | GND | I2C address = 0x68 |
| NCS | Pin 1 (3.3V) | High = I2C mode |
| CSB | Pin 1 (3.3V) | High = I2C mode |

## Wiring — TF-LC02 LiDAR (UART)

| TF-LC02 Pin | Raspberry Pi | Notes |
|---|---|---|
| VCC | Pin 2 (5V) | Shares 5V rail with IMU |
| GND | Pin 6 (GND) | Common ground |
| TX | Pin 10 (GPIO 15 / RXD) | LiDAR TX → Pi RX |
| RX | Pin 8 (GPIO 14 / TXD) | Pi TX → LiDAR RX |

UART enabled via `raspi-config`, serial console disabled. Device: `/dev/serial0`.

## Camera — Pi NoIR v3

- Connected to **CSI port 1** on the Pi 5
- Mounted **upside-down** (corrected with 180° CSS rotation on groundstation)
- Sensor: IMX708, max 12MP
- Streaming: 1920x1080 @ 30fps MJPEG over HTTP (port 8080)
- Library: picamera2 with hardware MJPEG encoder

## IMU Calibration & Orientation

MPU-6500 mounting orientation (determined via calibration tool):
- IMU +X = physical UP (gravity reads +1g on X when level)
- IMU Y = pitch axis (pitch down = gyro -Y)
- IMU Z = roll/forward axis (roll right = gyro +Z)

Body frame convention (right-hand, camera-centric):
- Body X = FORWARD (camera optical axis)
- Body Y = LEFT
- Body Z = UP

Data sent over WebSocket (port 9001) is in body frame:
- `accel`: [forward, left, up] in g
- `gyro`: [roll_rate, pitch_rate, yaw_rate] in deg/s
- Positive: roll right, pitch up, yaw right

Startup calibration: 2s stationary capture → gyro/accel bias saved to `pi/sensors/imu_cal.json`.
Use `--skip-cal` flag on `stream.py` to reuse previous calibration.

## Network Ports

| Service | Port | Protocol | Direction |
|---------|------|----------|-----------|
| Sensor stream (IMU + LiDAR) | 9001 | WebSocket | Pi → Browser |
| OptiFlow MJPEG (camera feed) | 8080 | HTTP | Pi → Browser |
| OptiFlow data (vectors, position) | 9002 | WebSocket | Pi → Browser |
| SDR control + IQ stream | 9003 | WebSocket | Pi ↔ Browser |
| Groundstation UI | 5000 | HTTP | PC local |

## Current Status

- [x] Project scaffolded
- [x] Context documented
- [x] Hardware connections (IMU + LiDAR wired and tested)
- [x] IMU driver (MPU-6500 over I2C)
- [x] LiDAR driver (TF-LC02 over UART)
- [x] Combined sensor WebSocket stream (port 9001)
- [x] OptiFlow: camera + sparse LK optical flow (port 8080 MJPEG + port 9002 WS)
- [x] Groundstation UI — IMU + LiDAR debug panel
- [x] Groundstation UI — OptiFlow debug panel (live feed + vector overlay + FOV toggle)
- [x] IMU calibration (gyro bias + accel bias at startup, persisted to imu_cal.json)
- [x] IMU axis remapping (IMU frame → body frame: forward/left/up)
- [x] Madgwick AHRS orientation filter (quaternion-based, groundstation 3D view)
- [x] IMU calibration discovery tool (groundstation panel)
- [ ] OptiFlow gyro compensation (subtract rotation from optical flow)
- [x] BladeRF driver + AquaSense calibration panel (signal generator + oscilloscope)
- [ ] BladeRF SFCW implementation
- [ ] Network protocol (formal)
- [ ] Integration testing
- [ ] SAR image reconstruction

---

## Maintenance Rules

**This file and CLAUDE.md must be kept up to date by Claude (or any AI assistant)
as the project evolves.** Whenever a session produces key information — design
decisions, hardware discoveries, protocol specs, calibration data, wiring
pinouts, architectural changes, or anything a future session would need — update
these files before the session ends. They are the persistent memory of this
project across sessions, collaborators, and machines.
