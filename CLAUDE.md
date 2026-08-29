# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

SFCW radar for within-wall imaging (rebar, pipes, voids, studs — not beyond the wall).
See CONTEXT.md for full system description.

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
- LiDAR: TF-LC02 (UART, 115200 baud default) — **wired to `/dev/serial0`, not `/dev/ttyAMA0`.**
  On this Pi 5, `dtoverlay=uart0-pi5` (the GPIO14/15 header UART, `/boot/firmware/config.txt`)
  enumerates as `ttyAMA10`, which `/dev/serial0` symlinks to. `/dev/ttyAMA0` is a *different,
  always-present* PL011 UART used internally for Bluetooth (`hci_uart_bcm`) — it opens
  successfully with no error, so a driver defaulting to it doesn't crash, it just silently
  reads nothing forever. `pi/sensors/tflc02.py` `TFLC02.__init__` now defaults to
  `/dev/serial0`; don't change it back to `/dev/ttyAMA0`. The `config.txt` comment above the
  overlay line still says "creates /dev/ttyAMA0", which is wrong for the Pi 5 — go by
  `/dev/serial0` in code, not that comment.
- IMU: MPU-6500 (I2C, address 0x68)
- SDR: bladeRF (USB, use libbladeRF / pybladeRF)
- Antennas: 2x Vivaldi (wideband, one TX one RX)

**IMU failure must not take LiDAR streaming down with it (fixed 2026-08-24).**
`pi/sensors/stream.py` `sensor_loop()` used to construct `MPU6500()` *before*
`TFLC02()`. When the IMU isn't responding on the I2C bus (`OSError: [Errno 121]
Remote I/O error` — confirm with `i2cdetect -y 1`, address `0x68` absent), that
constructor throws and kills `sensor_loop` before the LiDAR is ever initialized —
so a dead/disconnected IMU presented as "the lidar isn't working" even though the
LiDAR wiring and driver were completely fine. `sensor_loop` now builds the LiDAR
first and wraps IMU init in try/except: on failure it logs a warning and streams
`accel`/`gyro`/`temp` as `null` while LiDAR keeps working normally. Keep this
independence — don't let either sensor's failure gate the other.

**Extended 2026-08-24: the per-iteration reads are guarded too.** Init-time protection
was not enough — an IMU that enumerates fine at startup can drop off the bus later, and
`MPU6500._read_raw` -> `read_i2c_block_data` then raises `OSError 121` on *every* loop
iteration. That exception escaped `sensor_loop`, hit `log_task_exception`, and called
`request_stop()` — killing the whole `stream.py` process, so port 9001 went dead and the
groundstation reconnect-looped. Symptom: LiDAR/standoff reads `—` in the SFCW, C-scan and
BG Model panels (they all share `App.jsx`'s `lidarMm`) and the sidebar's IMU Hz tile also
reads `—`, while the SDR panel on port 9003 keeps working normally — which looks like a
LiDAR bug but is the IMU killing the shared stream. `sensor_loop` now wraps the IMU read
in try/except (streaming nulls) and disables the IMU after `IMU_FAIL_LIMIT = 20`
consecutive failures, because each failing read costs an I2C timeout that would otherwise
throttle the LiDAR rate. The LiDAR read is guarded the same way.

**Diagnosing a missing standoff readout:** the sidebar's IMU Hz tile is on every panel and
tells the two cases apart. Hz blank -> the sensor stream (port 9001) is down, check
`stream.py`'s stdout on the Pi. Hz live but Standoff `—` -> the stream is up and
`read_distance()` is returning `None`, so it's the TF-LC02 serial path (`/dev/serial0`).

**LiDAR silent-serial investigation (2026-08-24), unresolved — needs a bench check, not
more code.** `read_distance()` returns `None` because the TF-LC02 gives back literally zero
bytes on `/dev/serial0` — confirmed both actively (sending the `55 AA 81 00 FA` query) and
passively (just listening for 3s with nothing sent), before *and* after a physical power
cycle of the LiDAR board. A powered TF-LC02 replies to something; total silence on both
fronts across a power cycle rules out a code/protocol bug and points at wiring/connector,
not firmware or timing. Two things already ruled out, don't re-check them: (1) the driver
protocol itself — byte-for-byte identical to a completely separate fork on this same machine
(`~/version-venom`, different GitHub remote), so it isn't a broken deviation from something
that used to work; (2) no lost/alternate C-level implementation exists anywhere — full git
history and a filesystem-wide search turned up nothing, the driver has only ever been this
Python file. Per CONTEXT.md, TF-LC02 VCC shares Pin 2 (5V) with the IMU — worth checking that
connection specifically since it's exactly the rail that would've been disturbed while
rewiring the IMU. Next step is physically checking the LiDAR's VCC/GND/TX/RX leads at the
Pi header, not another round of software changes.

**Voltage ruled out (2026-08-24).** Checked the bench wiring against the table above: VCC is
3.3V and *not* shared with the IMU, contrary to what the table previously claimed (fixed in
CONTEXT.md too) — but the TF-LC02 runs on 3.3V by design, and this exact connection was
already confirmed working before, so this is not a mis-wiring and not the cause of the
current silence. Back to square one on root cause: wiring (VCC/GND/TX/RX) is correct and
was previously functional, yet the module now gives zero bytes both actively and passively
across a power cycle. Worth checking next: whether the connector is fully seated (could have
been jarred loose during the IMU rework even though it's on different pins), continuity
along the full length of each lead (not just voltage presence) rather than just at the
header, physical damage to the module or leads from handling during the IMU swap, and
whether anything in `/boot/firmware/config.txt` (the `dtoverlay=uart0-pi5` line) regressed
since it last worked. Still a bench/hardware problem, not a code problem.

**Pi-side UART stack fully checked (2026-08-24) and ruled out.** `dtoverlay=uart0-pi5` intact
in `config.txt`, `/dev/serial0` -> `ttyAMA10` as expected, `dmesg` shows clean PL011 init with
no errors, nothing else has the port open (`lsof`), user is in `dialout`, and `pinctrl get
14,15` shows both correctly muxed to UART0 TXD0/RXD0 (`a4`, idle-high — normal resting state).
A live passive-listen + active-query test against `/dev/serial0` still returned 0 bytes both
ways. Everything software/OS-side on the Pi is healthy — this is now isolated to the module
itself or its TX/RX leads specifically (not VCC/GND, both already confirmed fine). Next step:
unplug the LiDAR and jumper the Pi's TX (pin 8) straight to RX (pin 10) for a bare loopback
test — if that echoes back what's sent, the Pi's UART is fully exonerated and the module/its
TX-RX leads are the remaining suspect (dead unit, or a lead nicked during the IMU rework).

**RESOLVED (2026-08-24): root cause was a dead UART0 receiver on this Pi's RP1 chip — not
the LiDAR module, not any wiring.** With a bare TX(pin 8)-RX(pin 10) short confirmed solid by
continuity meter, a raw GPIO bit-bang test (toggle GPIO14, read GPIO15 with both pins pulled
out of UART mode) passed perfectly — proving the pins and the physical short were both fine.
But a live UART0 loopback still returned 0 bytes, and `TIOCGICOUNT` (via `fcntl.ioctl`,
`0x545D`) showed why: `tx` incremented into the hundreds of thousands while streaming (real
transmit activity, confirmed independently by `/proc/interrupts` counting real IRQs on the
`uart-pl011` line), but `rx` stayed at exactly 0 with zero frame/overrun/parity errors —
not even noise, total silence on the receive side specifically. Cross-check: live-applying
a second UART (`sudo dtoverlay uart3-pi5`, no reboot needed, brings up `/dev/ttyAMA3` on
GPIO8/9 = physical pins 24/21) and shorting *those* pins instead gave a clean, byte-perfect
loopback (icount rx=5/tx=5 for 5 bytes sent) — so this is not a board-wide or software issue,
it's UART0's receive path specifically. **Fix shipped:** `uart0-pi5` disabled (commented, not
removed) and `uart3-pi5` made persistent in `config.txt`; `tflc02.py` `TFLC02.__init__`
now defaults to `/dev/ttyAMA3` (was `/dev/serial0`) — **the earlier instruction above to
default to `/dev/serial0` no longer applies now that UART0 is dead; don't move it back.**
LiDAR now wired to physical pins 24 (TX) / 21 (RX) instead of 8/10; VCC (3.3V, not shared
with the IMU — see above) and GND unchanged. Live-tested end to end afterward with clean,
stable readings.

**Also found and fixed while re-testing (2026-08-24): `read_distance()` ignored the
protocol's own error code.** The TF-LC02 response includes an `error_code` byte (offset 6)
that `_read_response()` computed but never checked — an invalid/no-return measurement comes
back as literal distance `8888` with `error_code=4`, and the old code returned `8888` as if
it were a real reading. Confirmed via `read_distance_with_error()` that ~30-40% of reads at
the test bench alternated between valid (`error_code=0`) and this invalid sentinel — normal
behavior for this class of sensor (weak/no return depending on target angle/reflectivity),
not a hardware fault. `_read_response()` now returns `None` when `error_code != 0`, so
callers see the same "no reading yet" signal they'd get from any other transient failure,
instead of a spurious 8.888 m jump in the standoff display.

**IMU was a red herring the whole time — it simply wasn't physically connected.** After the
LiDAR fix, `i2cdetect -y 1` showed nothing at any address, matching CONTEXT.md's existing
note that the BNO085's VCC/GND pins were never confirmed after the chip swap. User checked
the bench and confirmed the BNO085 breakout was not plugged in at all. Once connected, it
enumerates at `0x4A` as documented and streams real accel/gyro data (verified live: resting
pose read `up ≈ 1.0g`, matching the axis-remap calibration check above). The original theory
that started this whole investigation — IMU and LiDAR sharing a 5V rail, one dragging the
other down — was wrong on every count: LiDAR VCC turned out to be 3.3V and not shared with
the IMU at all, and the two failures were completely unrelated (one a dead UART peripheral,
the other a bench cable never plugged back in).

**IMU hardware swap (2026-08-24): MPU-6500 -> BNO085. Driver shipped, axis calibration
still pending.** `mpu6500.py` is deleted (confirmed nothing else imported it); `pi/sensors/
bno085.py` is the new driver, wired into `stream.py` in place of it. BNO085 lives at I2C
`0x4A` (was `0x68` for the MPU-6500) and speaks SHTP over I2C, not simple register
read/write — a hand-rolled raw driver on `smbus2`/`i2c_msg`, matching this repo's other
sensor drivers (no framework dependency). `adafruit-circuitpython-bno08x` +
`adafruit-blinka` are installed on the Pi (`pip3 install --break-system-packages`, not in
`requirements.txt`) from cross-checking the protocol during bring-up; not used by the
shipped driver, safe to leave installed or remove.

**Bring-up history, useful if this ever needs debugging again:** initially every
`SET_FEATURE_COMMAND` (enable accelerometer/gyroscope/rotation vector) got zero response
while Product ID queries worked fine — the classic signature of the SH-2 application
firmware not running (stuck in bootloader/reduced mode). Ruled out corrected per-channel TX
sequence numbers (adafruit's library conflates host-TX/device-RX sequence counters into one
list — a real bug, see its `__init__.py` `_sequence_number` TODO — but not the cause here),
long settle times, full channel drains. **Fixed by power-cycling the board** — confirms it
really was a firmware-not-running state, not a protocol bug. If this regresses, power-cycle
before re-chasing protocol theories.

Packet shape (`accel`/`gyro`/`temp` fields, same consumers) is unchanged from the MPU-6500
era rather than switching to the chip's onboard sensor fusion (rotation vector) — smaller
blast radius, `imu_calibration.py`'s axis remap and the groundstation's Madgwick filter in
`ImuDisplay.jsx` keep working unmodified. `bno085.py` converts the calibrated accelerometer
report (m/s^2, Q8) to g (÷9.80665) and gyroscope report (rad/s, Q9) to deg/s (×180/π), so
nothing downstream needed to change for units. BNO085's SH-2 report set has no plain
temperature report — `temp` streams `null` for this driver, which every consumer already
handles gracefully (see the null-accel `ImuDisplay.jsx` crash fixed the same day).

**Fixed (2026-08-24) after TWO rounds of live testing: `imu_calibration.py`'s R_ACCEL/R_GYRO
axis remap for the BNO085.** Round 1's fix (a simple X<->Y swap, reasoned from the gravity
measurement + "pitch reads as yaw") was WRONG on its own terms — round 2's live feedback
was "pitch and roll are now swapped," meaning the true axis identity is a full relabeling of
all three raw axes, not the two-axis swap round 1 assumed:
  raw X -> roll axis (forward), raw Z -> pitch axis (left), raw Y -> yaw axis (up)
This resolves self-consistently: yaw was never reported wrong across either round, so raw Y
= up = yaw axis stands throughout (also matches the direct gravity measurement). Current
`R_GYRO`: `roll = -gyro_x, pitch = +gyro_z, yaw = +gyro_y`. **`R_ACCEL`'s forward/left rows
are inferred, not independently measured** — set equal to `R_GYRO`'s rows on the reasoning
that BNO085's SH-2 reports are documented to share one common sensor frame across
accel/gyro/mag (true for this chip, was NOT true for the MPU-6500 — its original R_ACCEL and
R_GYRO were genuinely different matrices, so don't assume this equivalence generalizes to
other hardware without checking). Verified: fresh calibration + resting pose gives
`up ≈ 1.0g, forward ≈ 0, left ≈ 0`.

**If a third round of "X is now swapped with Y" feedback comes in, stop patching
incrementally and ask for a full walk-through instead** (rotate slowly through each of
roll/pitch/yaw individually, one at a time, reporting the sign and which body-frame value
actually moves for each) — two rounds of partial feedback already produced one wrong
intermediate fix (round 1's swap), and a third partial round risks the same. A single
complete pass pins all three axes and their signs at once instead of iterating on which pair
is currently swapped.

**Testing trap: don't use "does the resting pose look level" as a check that the axis
remap is fine — it's a false negative for detecting a *remaining* problem,** even though it
correctly reproduces `up ≈ 1g` for whichever mapping is currently in place (round 1's WRONG
mapping also passed this exact check). `auto_calibrate` reruns on every `stream.py` startup
and its accel-bias step subtracts whatever the raw reading was *at that moment* from the
expected-gravity vector — calibrating and then immediately reading the *same* static pose
cancels out any remaining wrong-axis error, "up" reads ~1g regardless of whether R_ACCEL is
actually correct. The only real test is dynamic: tilt the board through a known roll/pitch/
yaw and see if the *reported* axis and *sign* match the *physical* motion — same as the
original MPU-6500 discovery procedure, and the only thing that's actually caught a problem
so far in this whole BNO085 remap effort.

**Fixed: BNO085's report backlog could hang `calibrate_gyro_bias` indefinitely.** Initial
`bno085.py` used a 128-byte read buffer and 10ms/100Hz report intervals for both
accelerometer and gyroscope. Each I2C read transaction has real cost regardless of whether
data is pending -- measured 12ms for a 128-byte read on this Pi's I2C bus, vs. 3.2ms at 32
bytes -- and the BNO085 pushes reports on its own schedule whether or not the host is
draining them. At 100Hz+100Hz combined against ~12ms/read, `read_all()`'s drain loop could
never catch up: every call hit its 32-read cap, batched packets grew past the 128-byte
buffer and got silently truncated, and `calibrate_gyro_bias`'s 200Hz sampling loop (400
samples, meant to take 2s) didn't finish within 20s in testing. Fixed by cutting the read
buffer to 48 bytes and both report intervals to 20ms/50Hz (matching `stream.py`'s default
loop rate) -- confirmed steady-state `read_all()` now does 3-5 reads per call, never near
the cap, and calibration completes in ~2s as intended. If report intervals ever need to
drop for a smoother display, drop the per-call read cap first and re-measure steady-state
read count before assuming it's fine -- don't just lower the interval and move on.

**Fixed (2026-08-24): the whole sensor stream was capped at ~7-10Hz by the dead LiDAR,
not by the BNO085 swap.** `TFLC02.read_distance()` blocks on a 100ms UART timeout when the
sensor doesn't answer (measured directly: every call took exactly ~100ms while the LiDAR
issue above was unresolved), and `sensor_loop` used to `await` it inline in the same loop
that reads the IMU and broadcasts -- so a silent LiDAR throttled the *entire* stream to
~1/0.1s = 10Hz regardless of the `--rate` flag, IMU included. This was reported as "the IMU
feels choppy, worse than the MPU" -- plausible red herring, since the MPU-6500 setup was
presumably running while the LiDAR still answered quickly, so the same blocking-inline
pattern never showed up as a problem. `sensor_loop` now runs `imu_poll_loop` and
`lidar_poll_loop` as separate background tasks, each polling its sensor in its own uncapped
loop via `run_in_executor` and publishing the latest reading into a shared dict; the
broadcast loop just reads those dicts and never awaits either sensor directly. Verified: a
still-unresponsive LiDAR (100ms/read, unchanged) no longer affects IMU rate at all --
measured 48-48.7Hz broadcast throughput at `--rate 50`, up from 7.67Hz before this fix. This
also means the stream will keep running at full rate once the LiDAR hardware issue above is
eventually fixed, not just work around it today.

**bladeRF total-sample-throughput warnings explained (2026-08-24).** The
`check_total_sample_rate` warning in libbladeRF sums each active channel's *actual* achieved
sample rate (`bladerf2.c` reads it back via `get_sample_rate`), not the rate Python
requested. `bladerf_driver.py` `_configure_channels_dual()` was calling
`bladerf_set_sample_rate(..., ffi.NULL)` for the `actual` out-param — silently discarding
whether the RFIC's clock/decimation chain rounded the requested rate to something else.
SFCW's `_configure_hardware()` requests 10 Msps; the observed warning math (92.16 / 3
channels, 122.88 / 4 channels) both divide out to exactly 30.72 Msps per channel, so that's
almost certainly what the hardware actually snapped to. Fixed by capturing `actual` (both in
the raw-ffi dual-channel path and by reading back `Channel.sample_rate` after the
Python-wrapped single-channel sets) and logging a `[bladerf] NOTE: <ch> sample rate snapped
to X Msps (requested Y Msps)` line when it differs — visibility only, no behavior change, so
it's safe without live hardware to test against. **The 30.72 Msps hypothesis is now
FALSIFIED (measured on hardware 2026-08-28).** Calling `bladerf_set_sample_rate(..., actual)`
for 10 Msps on all four channels (RX0/RX1/TX0/TX1) returns `rc=0` with
`actual = 10.000000 Msps` on every one — the RFIC hits the requested rate exactly and does
not snap. So whatever produced the 92.16 / 122.88 warning totals, it was not SFCW's 10 Msps
request being silently rounded to 30.72. Dual-channel RX at 10 Msps also streams cleanly
(60/60 buffers, no timeouts), so sweep-time and RX-timeout problems should not be blamed on
sample-rate snapping — see the FPGA tuning-mode section below for what actually caused the
RX timeouts. Actually eliminating the warning (picking a request rate
the RFIC can hit exactly, e.g. a rate near the well-known 30.72 Msps LTE-grid family) needs
live-hardware validation before changing — RF gain/timing code in this repo has a history of
regressions from unverified changes (see the `settle_count`/`num_buffers` regressions
above), so don't just guess a lower rate to silence it without testing on the bench.
The `[INFO @ .../version.c]` firmware/FPGA-newer-than-compatibility-table lines are harmless
and expected — libbladeRF's bundled compatibility table just lags the flashed firmware/FPGA
versions; ignore them, don't chase a libbladeRF upgrade just to silence an INFO line.

## Living Documentation Rule

CLAUDE.md and CONTEXT.md are living documents. Whenever you learn key information
worth persisting — new design decisions, hardware findings, protocol choices,
calibration values, architectural changes, or anything a future session would
need to know — update CLAUDE.md and/or CONTEXT.md immediately. Don't wait to be
asked. These files are how context survives across sessions and collaborators.

## Current Phase

IMU, LiDAR, and bladeRF SDR integrated. All stream to groundstation debug panels.
RF Calib panel provides signal generator + oscilloscope for bladeRF calibration — always
runs both channels (antenna TX1/RX1 + reference TX2/RX2 loopback) simultaneously, viewport
split left (antenna) / right (reference) for both TX and RX.
SFCW panel performs stepped-frequency sweeps (2–5 GHz, hard-bounded by the quick-tune master
table's 256-profile hardware ceiling — see Quick-tune master table below) with range profile
+ waterfall display.
Both RF panels share port 9003 — starting an SFCW sweep auto-stops any active TX/RX in RF Calib.
C-scan panel rasters a 2D grid of positions over the target and shares the SFCW panel's
background model machinery (see below).
Imaging Bench panel replays an exported waterfall snapshot through 11 selectable imaging
effects for offline A/B of processing chains — see below.

## SFCW Amplitude Scaling (Dynamic / Manual)

The SFCW panel carries an `sfcwScaleRange = { dynamic, min, max, isDb }` (App.jsx), the
same shape the C-scan panel uses for its colour scale. Dynamic (the default) is the old
behaviour: the range profile's Y axis tracks session-wide extremes and the waterfall's
colour range tracks its visible history. Manual pins **both** panes to one pair of limits.

Seeding matters: the live limits are computed inside `SfcwDisplay`, not the panel, so the
display publishes them every frame through `onDynamicScale` into an App-level **ref**
(`sfcwDynamicScale`) — a ref, not state, so a 3–6 Hz sweep does not re-render the sidebar.
The panel reads it via `getDynamicScale()` at the moment the toggle is clicked, so switching
to manual never makes the colours or the axis jump.

`isDb` records which units the pinned numbers are in. Flipping the display's dB/LIN button
(or "Reset Scale") hands the scale back to dynamic, because dB limits are meaningless on a
linear trace. Panes flag a pinned scale with an amber `MANUAL` next to their title, and the
waterfall's colour-bar numbers turn amber too.

The other two `SfcwDisplay` instances (C-scan and BG Model live sweep) pass no `scaleRange`
and stay dynamic — `manual` is false whenever the prop is absent.

## Background Subtraction — Groundstation Only (SFCW + B-scan)

All background subtraction happens on the groundstation. The Pi ships raw `h_cal`,
holds no background state, and has no notion of a B-scan at all. These commands no
longer exist: `sfcw_capture_bg`, `sfcw_clear_bg`, `sfcw_bg_mode`, `bscan_clear_bg`,
`bscan_capture`, `bscan_bg_capture`, `bgmodel_capture`. Every "capture" now works by
tagging the next `sfcw_result` to arrive, groundstation-side, with a ref flag.

Both panels offer the same two mutually exclusive sources:
- **Captured reference** — "Capture BG" tags the next sweep as `sfcwBgRef` / `bscanBgRef`.
- **ML model** — "Load Model" infers a background from lidar standoff (`bgModelInfer.js`).

Selecting either clears the other; "Clear BG" clears both. Subtraction is always complex
(vector) — the old complex/magnitude toggle is gone, complex was the default and is now
the only mode.

- SFCW live display: `App.jsx` `processedSfcwResult`.
- C-scan: `lib/bscanBg.js` `applyBscanBg()`, shared by `processedBscanData` (C-scan +
  2D Map), `sarProcessedData` (SAR), and `alignedSvdData` (Aligned).

**The model path is strictly better for B-scans.** A captured reference is only valid
near the standoff it was taken at, so B-scan positions are corrected by phase-aligning
it with the lidar standoff difference — a fudge that degrades as the hand-held standoff
drifts. A model is evaluated at *each position's own* standoff, so no alignment is
needed and it stays valid across the whole captured span. Outside that span the Akima
interpolator clamps, so the panel flags standoffs beyond the model's `d` range.

The Aligned panel subtracts first and rotates the residual to the common reference
position. That is identical to rotating both and subtracting (the alignment ramp is a
common factor) and it lets the model see each position's true standoff.

**Why groundstation-side:** Pi-side subtraction ran before transmission, so it silently
contaminated B-scan captures, SAR, and BG-model *training* data, which all read
`msg.h_cal_*`. Keeping the wire raw means only the live display is affected.

Note `SfcwDisplay` recomputes its own range profile from `h_cal_real/imag` for
windowing/range-comp, so any subtraction must write back into those fields — replacing
only `magnitudes`/`distances` gets silently discarded. `applyBscanBg` does this.

**Removed from the panel:** the SVD filter (the Aligned, SAR and 2D Map panels
keep their own; `lib/svd.js` stays) and the Wall section. Wall standoff / thickness /
permittivity were never doing refraction work in practice — εr defaulted to 1, so the
distance correction was the identity and the only live effect was capping display depth
at the wall thickness. That is now a single `maxDepth` field (cm, default 30) under
Display, used by both `BscanDisplay` and `sar.worker.js`. Export is v5 (see the C-scan
section); import still reads v3 and maps the old `wallThickness` onto `maxDepth`.
Pi-side architecture: bladerf_driver.py (HAL) → sfcw_engine.py (sweep logic) → sdr_server.py (WebSocket).

**SFCW params are pushed groundstation → Pi, never read back.** The engine carries its
own defaults, and `sfcw_set_params` used to be sent only from a panel field's `onChange`,
so a fresh page load left the Pi sweeping at its defaults while the panel displayed and
derived everything (step count, sweep time, max range) from different ones. `App.jsx`
`sendSfcwParams()` now pushes the full set on SDR connect and again before every
`sfcw_start` (all three start paths: both `App.jsx` handlers and the panel's own toggle).
The panel is the source of truth; keep new SFCW params in that payload or they will not
reach the Pi.
Next steps: SAR reconstruction integration.

## Imaging Bench Panel — Offline Effect Comparison (2026-08-23)

Panel id `imaging` (`ImagingPanel.jsx` + `ImagingDisplay.jsx` + `lib/imagingEffects.js`),
sitting after `sfcw` in the `PANELS` array. It is **entirely offline**: it reads a
`waterfall_snapshot` JSON exported from the live SFCW waterfall and re-processes it through
a menu of 11 selectable imaging effects, so processing chains can be A/B'd against identical
recorded data without going back to the bench. It never touches the SDR socket.

**All effect math lives in `lib/imagingEffects.js` as pure `(snapshot, params)` functions**
returning plain arrays plus axis metadata. `ImagingDisplay` contains no signal processing —
it memoizes and draws. That split is what makes the effects testable head-first from node
with no React (see the round-trip check below).

### `rawHistory` — the raw complex ring buffer in SfcwDisplay

`waterfallHistory` stores only scalar magnitude rows (dB or linear per `scaleMode`) and is
wiped on every `scaleMode` change, so five of the effects — phase-as-hue, coherence, coherent
integration, dispersion, raw S21 — could not be built from it. `rawHistory` is a parallel
`useRef` buffer with the same `WATERFALL_MAX_ROWS = 100` cap, pushed in the same effect so
row *i* of one lines up with row *i* of the other. Each entry is the sweep untouched by
window / range-comp / averaging / dB conversion:

```
{ real: Float32Array, imag: Float32Array, num_steps, step_size, range_offset,
  start_freq, stop_freq, timestamp, phase_coherence }
```

Source is `sfcwResult.h_cal_real/h_cal_imag` via `hCalRef` (which now also caches
`start_freq` / `stop_freq` / `timestamp` / `phase_coherence`). It is cleared **only** on
unmount, never on a `scaleMode` flip — raw sweeps are unit-agnostic so there is nothing to
invalidate, and that is the one case where the two buffers can differ in length.

A `rawCount` state mirror exists purely so the EXPORT button can enable/disable itself; the
buffer is never read through React. The existing live render path is unchanged.

### `waterfall_<ts>.json` v1 format

Written by the neutral `EXPORT` button in the waterfall pane (`bottom-10 left-14`, inside the
waterfall's own relative container, so it sits alongside — not over — the range profile's
dB/LIN toggle). Gated on `!hideWaterfall`, so only the SFCW panel's instance has it; the
C-scan and BG-model instances do not. Disabled and dimmed when the buffer is empty.

```json
{
  "version": 1,
  "type": "waterfall_snapshot",
  "timestamp": "<ISO>",
  "common": { "num_steps": 51, "step_size": 60000000, "start_freq": 2000000000,
              "stop_freq": 5000000000, "range_offset": 0.5 },
  "displayState": { "scaleMode": "linear", "windowType": "rectangular",
                    "kaiserBeta": 3, "rangeComp": 0, "avgCount": 1 },
  "sweeps": [ { "t": 1755900000.12, "real": [], "imag": [],
                "phase_coherence": { "phase_std_rad": 0.11, "coherent": true } } ]
}
```

`sweeps` is oldest-first; `real`/`imag` are rounded to 8 decimals like the Pi does. ~124 KB
for 100 sweeps × 51 steps. `displayState` is **provenance only** — `App.jsx`
`handleLoadImagingSnapshot()` uses it to seed the bench's "None" mode and the shared
range-profile knobs so the bench opens on the image the operator was looking at, and it is
applied to nothing else.

**`sfcw_result` now carries `start_freq` / `stop_freq`** (`sfcw_engine.py` `_process_h_cal`).
This is the only Pi-side change the panel required. `stop_freq` is the *last frequency
actually visited* (`start + (num_steps-1)*step`), which equals `self.stop_freq` only when the
step divides the span evenly. Dispersion and raw-S21 need the real RF axis and deriving it
from `step_size` alone is guesswork. `snapshotFreqs()` falls back to step index for
pre-`start_freq` snapshots and `freqsKnown()` flags it; the panel says so in the readout.

### The 11 effects

| # | id | What it computes |
|---|---|---|
| 0 | `none` | Reference image — identical processing to the live waterfall |
| 1 | `compression` | `(\|H\|/peak)^p`, a continuous dial where dB and linear are two points |
| 2 | `percentile` | Colour limits from percentiles, whole-history or per-row |
| 3 | `binnorm` | Per-bin temporal normalisation — adaptive clutter map, no capture, no model |
| 4 | `cfar` | Signal / CFAR threshold in dB, so 0 dB is the detection threshold |
| 5 | `colormap` | Same image under all five maps side by side |
| 6 | `phasehue` | Hue = phase of the complex profile, value = magnitude |
| 7 | `coherence` | Normalised complex correlation at lag L over a sliding window |
| 8 | `integration` | Coherent vs non-coherent averaging, and their ratio |
| 9 | `dispersion` | Sub-band sweep — range across, sub-band centre frequency up |
| 10 | `s21` | Calibrated `h_cal` against frequency, before any IFFT |

Notes on the ones with non-obvious choices:

- **Effects 3, 7, 8 need multiple sweeps.** They return `{kind:'message'}` on a one-sweep
  snapshot and the dropdown disables them, rather than rendering garbage.
- **Effect 8 integrates in the range domain, not on `h_cal`.** Averaging complex `h_cal` over
  K sweeps and then transforming is *identical* to averaging the complex range profiles (the
  IFFT is linear), and the non-coherent partner — a mean of magnitudes — only means anything
  in the range domain. Averaging `|h_cal|` in frequency and then transforming would be
  nonsense. Side-by-side gives coherent and non-coherent one shared colour scale, which is
  the whole comparison; the ratio pane is a relative quantity in different units so it
  carries its own scale, marked `OWN SCALE` in amber.
- **Effect 9's sub-band count is capped by width and overlap.** `hop = subWidth*(1-overlap)`,
  so `maxCount = floor((numSteps-subWidth)/hop)+1`; the count slider is clamped to that and
  the canvas says so when it bites. The default `overlap` is **0.6**, which is where the
  default 8 sub-bands actually fit across a 51-step sweep — at 0.5 only 6 do. A sub-band
  starting at a non-zero step does not shift range (range is set by the *rate* of phase
  change with frequency, not the offset), so all sub-bands share one range axis.
- **Effect 10's residual mode is a direct corrupted-sweep detector** and is the reason it
  exists — see the `settle_count` regression history above. A sweep is flagged red when
  `max(computed_std, phase_coherence.phase_std_rad) > 0.3 rad`, matching the Pi's own cut.
  `real & imag` has no single scalar to colour a waterfall with, so that combination stays a
  line plot regardless of the display radio, and says so.
- **CFAR and the window functions were lifted out of `SfcwDisplay` into
  `imagingEffects.js`**, so both panels now call one implementation; CFAR gained GO/SO
  variants (GO holds the threshold up on the far side of the wall return, where CA lets a
  clutter edge drag it down). `computeCFAR` accumulates its CA sum in a side-then-k order
  that looks redundant next to the per-half accumulators the GO/SO variants need — **do not
  "simplify" it into `(loSum + hiSum) / (loCount + hiCount)`.** Float addition is not
  associative and that rewrite shifts the threshold by ~3e-14 dB, which is what the current
  form deliberately avoids: the live display's output is bit-identical to what it produced
  before the lift, verified across window lengths 51–256, Kaiser β 2–14 and five CFAR
  parameter sets.
- **CFAR runs on the full profile and clips afterwards**, so the range-zoom edges do not get
  a one-sided training window.
- **Range compensation is folded into the complex profile** as an amplitude gain of
  `r^(n/2)`, which is exactly the `+ n*10*log10(r)` dB the live display applies — doing it in
  `prepare()` keeps magnitude and phase consistent for the complex effects.

### Structure and cost

`prepare(snapshot, profile)` does the windowing and zero-padded IFFTs once and is memoized on
`[snapshot, params.profile]`; every range-domain effect reads its output, so switching effects
or dragging an effect slider never redoes them. Measured on 100 sweeps × 51 steps: `prepare`
7 ms, every effect ≤ 9 ms, worst case (sliding median, K=50, zero-pad ×8) 32 ms. No manual
Apply button is needed and none exists — every parameter updates the render immediately.

The View section's range zoom is applied **before** colour limits are computed, so percentiles
and dynamic scaling describe what is actually on screen. The colormap choice is global: it
persists as the active map across every effect, not just while entry 5 is selected.

`ImagingDisplay` draws via an offscreen `nx × ny` canvas + `putImageData` + one scaled
`drawImage`, not per-cell `fillRect` — at 100 × 1024 bins the latter is tens of thousands of
fills per frame. Non-finite cells (short coherence windows, masked bins) render as a dark grey
no colormap produces, so they are never mistaken for data.

### Verification

Effect math was checked head-first from node against a synthetic two-target scene: peak bins
land within one bin of the true range (0.22 / 0.60 / 1.00 m → 0.2196 / 0.6002 / 1.0003 m at
zero-pad ×8, 4.9 mm bins). The full export → import → validate → render chain was exercised
with the verbatim export payload, and all 11 effects were rendered in a real browser to
confirm the canvas output. There is no test runner in this repo, so those checks were
throwaway scripts rather than committed tests — worth rebuilding as real tests if
`imagingEffects.js` grows.

## Sweep Timing (measured 2026-08-20)

**Measured sweep times** at 151 steps (20 MHz spacing, 2–5 GHz):
- Mean: 548 ms, effective rate 1.82 Hz.
- Per-step time: 3.63 ms (10 settle buffers × 4096 samples / 2 Msps = 20.5 ms settle
  + 1 capture buffer, but the real wall time per step is 3.63 ms because RX callbacks
  overlap — the settle wait is for *new* callbacks arriving, not elapsed time).

The per-step wait is `settle_count` RX buffer callbacks in `_sweep_core`, now a
user-controlled `SFCWEngine` param (default 0 since 2026-08-28, see "Settle count set
to 0" below; it was 10 before that — exposed in the panel as "Settle",
same param family as `num_buffers`/"Buffers") rather than hardcoded. Sweep RX buffers
are 4096 samples at the 10 Msps set in `_configure_hardware`, i.e. 0.41 ms per buffer —
`BUFFER_SAMPLES` / `SAMPLE_RATE` in `SfcwPanel.jsx` mirror those two numbers and must
track the engine. `num_buffers` genuinely averages that many post-settle captures per
step now (see Quick-tune master table below) — the panel's per-step estimate is
`(settle_count + num_buffers) * 0.41ms`.

**Regression, 2026-08-20 to 2026-08-23 (fixed): do not drop `settle_count` below 10
without a real per-step validation.** An optimization pass (`407e205`, `510a9fe`) cut
the quick-tune `settle_count` from 10 to 7, gated behind an experimental
`sweep_mode='fast'` flag with an explicit "reduced if Test C proves it safe" caveat —
then the very next commit merged it in as the unconditional default and rewrote the
caveat into an unsubstantiated "validated over 50 sweeps" claim, with no test artifact
in the repo. Symptom: intermittent fully-garbled sweeps (good scans mostly,
occasionally one random-looking sweep, rarely two in a row) — one step retuning late
means its capture still holds the previous frequency's IQ, and since the range profile
is one IFFT across all steps, a single bad bin corrupts the whole sweep rather than
just that bin. Default reverted to 10. If it ever needs to drop again, validate with a
per-step check (flag/log which step index was corrupted), not just an aggregate
correlation over whole sweeps — an aggregate metric is exactly what let this ship
unnoticed. `benchmark_sweep.py` is a leftover from that pass and is currently broken
(references `_sweep_core_fast`/`sweep_mode`/`_qt_profiles_rx`, all since removed) —
needs a rewrite against the current `_sweep_core`/master-table API before it's useful
again.

### Settle count set to 0, and per-step sweep timing (2026-08-28)

`settle_count` default is now **0** (`SFCWEngine.__init__`, `App.jsx` `sfcwParams`,
`capture_bgmodel.py` `SFCW_PARAMS`; the panel's "Settle" field now allows 0, and
`set_params` clamps at 0 instead of 1). At 0 the sweep discards nothing after a retune
— it keeps the very next `num_buffers` RX callbacks to arrive. This was an explicit
user request, made with the regression above in view: it is the same knob that caused
the intermittently-garbled sweeps, so if random-looking sweeps reappear, raise "Settle"
first before looking anywhere else. The per-step timing below is the tool for judging
what settle actually costs — check `tune->ack` and `rx buffers` against each other
rather than guessing.

`_sweep_core` now times every step and splits it into: **tune->ack** (the
`bladerf_schedule_retune`/`bladerf_set_frequency` call, which returns only once the
NIOS acknowledges, so it is a real command→ACK span), **settle** (waiting
`settle_count` buffer arrivals), **rx buffers** (waiting for and collecting
`num_buffers` fresh buffers), **noise avg** (the multi-buffer complex averaging math),
and **other** (leftover Python overhead, including the progress callback). Sweep-level
timers cover grid build, reference divide, and `_process_h_cal` (window + IFFT), ending
in a sweep total and rate. `_phase_stats` reduces each phase to total/mean/min/max;
`_merge_timings` aggregates sub-sweeps for warm B-scan averaging (`bscan_avg_count > 1`)
by summing totals and re-deriving the mean, so the numbers stay honest across an
averaged capture.

Output goes two places: three `[sfcw]` lines printed per sweep (silence with
`set_params(timing_log=False)`), and a `timing` key on the `range_profile` payload, so
the groundstation can display it without another round trip. `_perform_sweep_raw` now
returns `(h_cal, timing)` — callers must unpack. `benchmark_sweep.py` predates all of
this and is still broken; the in-engine timing supersedes what it measured.

**Regression, 2026-08-20 to 2026-08-23 (fixed): `num_buffers` default silently dropped
from 4 to 1, killing per-step noise averaging.** The `c33b0ce` "clean up" commit (same
day as the `settle_count` regression above) trimmed `sfcwParams`/`SFCWEngine` defaults
and dropped `numBuffers` from 4 to 1 — with no discussion, apparently just collateral
from tidying the defaults block. It went unnoticed at the time because the multi-buffer
averaging in `_sweep_core` was *itself* separately broken by the `407e205`/`510a9fe`
optimization pass: `num_buffers` only extended the settle wait but the code always
grabbed the single latest RX buffer regardless of its value, so for a few days the
setting had no effect at any value. `f98e208` (2026-08-23) fixed the averaging to
actually capture and mean `num_buffers` fresh buffers per step — but the default was
already 1, so the fix's benefit stayed invisible (1 buffer averaged with itself is a
no-op) until the default was corrected back. Symptom: sweep-to-sweep correlation stays
high (scene/multipath structure is unchanged) but per-sweep amplitude/phase noise is
visibly higher than before, burying fainter returns — because each step went from
averaging 4 captures (~6 dB of free SNR, `10*log10(4)`) down to 1. Confirmed live on
2026-08-23: 15-sweep static-scene comparison via the running `sdr_server`, mean
complex-domain deviation between sweeps was 0.0055 at `num_buffers=1` vs 0.0034 at
`num_buffers=4` (~39% reduction). Default restored to 4 in both `App.jsx` and
`SFCWEngine.__init__`. If `num_buffers` is ever dropped for speed again, check the
*current* live-sweep wobble against a static scene first, not just correlation —
correlation is insensitive to this because it doesn't wreck sweep structure, only
buries weak signal in noise.

## FPGA tuning mode kills the RX stream on the bladeRF 2.0 — do not re-enable (2026-08-28)

**Symptom:** RF Calib panel works fine, but starting an SFCW sweep gives
`[ERROR @ .../libusb.c:1089] Transfer timed out for RX buffer ...` +
`[bladerf] RX dual error: Operation timed out`, and no sweep is produced at all.

**Cause:** `SFCWEngine._configure_hardware()` called `driver.set_tuning_mode_fpga()`
(`bladerf_set_tuning_mode(BLADERF_TUNING_MODE_FPGA)`). On the bladeRF 2.0 micro that call
*succeeds* (`rc=0`, prints "Tuning mode set to FPGA") and then silently breaks the RX_X2
data path: `sync_rx()` starts throwing `TimeoutError` about 8 buffers later. Because
`_rx_loop_dual` catches the exception and exits, `_rx_seq` stops advancing, so every step of
`_sweep_core` falls through its `rx_cond.wait(timeout=1.0)` and the sweep returns nothing.

**Bisected on hardware** (device free, 10 Msps, RX_X2, same `sync_config` the driver uses):

| test | result |
|---|---|
| stream only | OK, 60/60 buffers |
| `set_tuning_mode(FPGA)` only | **FAILS after 8 buffers** |
| quick-tune master table only (151 profiles, no FPGA tuning) | OK, 60/60 buffers |
| both | **FAILS after 8 buffers** |

So the quick-tune table is innocent — it was *only* the tuning mode. Note the failure happens
before any `bladerf_schedule_retune()` call, so it is not a retune problem either.

**Not an FPGA-image problem.** Reproduced identically with the flashed image (0.16.0, "configured
from SPI flash") *and* with Nuand's official `v0.16.0/hostedxA9.rbf` downloaded and loaded into
RAM (`bladeRF-cli -l`, reports "configured by USB host"). Reflashing does not help — don't.
Test FPGA images with `-l` (RAM, reverts on power cycle), not `-L` (SPI flash), when
diagnosing; it is free to undo.

**Why it was never going to work:** libbladeRF's own `default_tuning_mode()`
(`host/libraries/libbladeRF/src/board/bladerf2/common.c`) opens with an unconditional
`mode = BLADERF_TUNING_MODE_HOST;`, and the `if (BLADERF_TUNING_MODE_FPGA == mode && ...)`
errata check immediately after it is dead code that can never run. FPGA tuning on bladerf2 is
reachable *only* via `BLADERF_DEFAULT_TUNING_MODE=fpga`, and the errata text it guards refers
to "errata related to FPGA-based tuning". Nuand does not default this board to FPGA tuning.

**Fix shipped:** the `set_tuning_mode_fpga()` call is removed from `_configure_hardware()`
(the comment there explains why — keep it). `driver.set_tuning_mode_fpga()` itself is left in
`bladerf_driver.py` but is now uncalled; `_fpga_tuning` was a write-only flag nothing ever
read, and is now just set False.

**It costs nothing.** Quick-tune still works in host tuning mode: `bladerf_schedule_retune()`
returns `rc=0` for every step, and a 51-step sweep measured **230 ms (4.35 Hz)**, inside the
3–6 Hz band this panel has always run at. Verified end-to-end through `SFCWEngine` itself:
3/3 sweeps, 51 steps each, no errors, sweep-to-sweep correlation **0.9984**.

**Caveat left open:** those verification sweeps ran with the antennas pointed at open room, and
reported `phase_std ≈ 1.44 rad` -> `coherent=False` (the Pi's cut is 0.3). Sweep-to-sweep
correlation of 0.9984 says this is repeatable structure, not the retune-timing corruption that
check exists to catch (corrupted sweeps do not repeat). Still worth re-confirming against a
known target that the range profile looks right.

## Quick-tune master table (2026-08-23)

Per-grid quick-tune profile caching is gone. `SFCWEngine._ensure_master_quick_tune_table()`
generates one fixed table spanning `QT_MASTER_START_FREQ`–`QT_MASTER_STOP_FREQ` (2–5 GHz)
at `QT_MASTER_STEP` (20 MHz) once per device connection — 151 profiles, paying the full
per-frequency VCO-cal cost (`bladerf_set_frequency` + `bladerf_get_quick_tune`) only that
once, ~6s total. `set_params()` snaps `start_freq`/`stop_freq` to the nearest 20 MHz and
clamps them into that range, and snaps `step_size` to a 20 MHz multiple (`_snap_freq`/
`_snap_step`), so every sweep's frequencies are guaranteed to land exactly on master grid
points. `_build_sweep_grid()` then just indexes into the cached table — no regeneration,
no device reset — so start/stop/step can change freely mid-session, live, with no
interruption.

This replaced the old scheme: profiles were cached per-`(start, stop, step)` combo, and
changing any of those three flipped `_freq_grid_dirty`, which forced a full
`driver.reset()` + reconfigure + restream on the next sweep (or mid-sweep, via
`_reconfigure_for_new_grid()`). That reset path was unreliable in practice — bladeRF
errors on the reopen — which is why it's gone rather than fixed. The master table only
needs invalidating (`SFCWEngine.invalidate_quick_tune_table()`) after an explicit
`device_reset` from the panel; `sdr_server.py`'s `device_reset` handler calls it.

**Hard ceiling: `MAX_QUICK_TUNE_PROFILES = 256`, do not exceed it.** The first version of
this table tried 1–6 GHz at 10 MHz spacing (501 profiles) and it was broken: verified
against libbladeRF's own source on the Pi
(`~/bladerf-src/host/libraries/libbladeRF/src/board/bladerf2/bladerf2.c:1419-1513`),
`bladerf_get_quick_tune()` is not a stateless read — every call *writes* a new fastlock
profile into a fixed-size on-device table (`board_data->quick_tune_tx/rx_profile`, capped
at `NUM_BBP_FASTLOCK_PROFILES = 256` in `fpga_common/include/bladerf2_common.h`, one shared
counter per direction across both TX/RX sub-channels). That counter only resets on a full
`bladerf_open()`. Past 256 calls it returns `BLADERF_ERR_UNEXPECTED` and leaves the profile
struct unpopulated — the original code didn't check the return code, so it silently stored
zeroed/garbage profiles for every frequency past the 256th, which `bladerf_schedule_retune()`
would then happily retune to the wrong RF state. Symptom on stdout: a wall of
`[ERROR @ .../bladerf2.c:1427/1456] Reached maximum number of TX/RX quick tune profiles.`
repeated once per frequency past the cap, on every `start.py` run. `_ensure_master_quick_tune_table()`
now raises immediately if `len(freqs) > MAX_QUICK_TUNE_PROFILES` (compile-time check) or if
`bladerf_get_quick_tune()` ever returns nonzero (runtime check) — fail loud, never store an
unchecked profile. 2–5 GHz at 20 MHz is 151 profiles, comfortably under 256.

Consequence: the sweep range is hard-bounded to 2–5 GHz (panel Start/Stop min/max 2000/5000
MHz) — anything requested outside that gets clamped, and step size floors at 20 MHz. Widening
either means trading against the 256-profile ceiling (span_MHz / step_MHz + 1 ≤ 256) — there's
no way to have both a wide range and fine resolution simultaneously on this hardware without a
different strategy (e.g. a lazy per-frequency cache with a reset-triggered eviction, discussed
and deferred 2026-08-23 in favor of just picking a range/step that fits).

**Default step size is 60 MHz (51 steps, 2–5 GHz)** — `sfcwParams.stepSize` in
`App.jsx` and `SFCWEngine.step_size` both carry it, and the groundstation pushes its
value to the Pi on connect (see the param-push note above).

## C-Scan Panel — 2D Raster (replaced the B-scan panel, 2026-08-20)

The B-scan panel is gone; `CscanPanel.jsx` + `CscanDisplay.jsx` + `lib/cscanGrid.js`
replace it. Panel id is `cscan` (was `bscan`). App-level state keeps its `bscan*` names
(`bscanData`, `bscanParams`, …) because the underlying record is still one B-scan trace
per position — only the panel and its geometry changed.

**Grid.** `bscanParams` is now `{ hCount, hStep, vCount, vStep, maxDepth, gateStart,
gateEnd, metric }`. `stepSize` / `numPositions` are gone; SAR and the 2D Map are 1D and
read `stepSize: hStep` (injected in `sarParams` / `mapStepSize`) with the position count
taken from the data length as before. The Scan Grid section sits between Session and
Capture so the rectangle is described before any sweep is tagged.

**Snake raster order** (`lib/cscanGrid.js` `cellForIndex`). Capture starts at the
bottom-left cell, sweeps the bottom row left→right, steps up one row, sweeps right→left,
steps up, and repeats. Verified: a 3×2 grid captures (0,0) (4,0) (8,0) (8,6) (4,6) (0,6)
for hStep 4 / vStep 6. Every position stores `grid_ix`, `grid_iy`, `x_cm`, `y_cm`,
resolved from the capture index at capture time in the `sfcw_result` handler (via
`bscanParamsRef`), so editing the grid afterwards never relabels existing cells. Lidar
standoff is captured per cell exactly as before.

**Display.** The viewport is Live Sweep (top) over C-Scan Grid (left) + the selected
row's B-scan (right). The grid is a plan view holding the physical aspect ratio, colour =
`gatedIntensity()` over the depth gate (peak / energy / mean), drawn live as cells fill.
Uncaptured cells are outlined and empty; a cell captured with no range bin inside the gate
is mid-grey, distinct from uncaptured. The next target pulses cyan, the snake path is
dashed over the captured cells, and clicking a cell picks the row shown in the B-scan pane
(that pane sorts the row by `grid_ix`, so a right→left row still reads left→right).

**Colour scaling** is one `{ dynamic, min, max }` object shared by both panes. Dynamic
tracks the captured cells; switching to manual seeds the sliders from the current dynamic
limits so colours do not jump, then the two dB sliders drive both images live. The sliders
are disabled and dimmed while dynamic is on, and the colour bar turns amber and reads
MANUAL when it is off.

**Export is v5** (`cscan_<ts>.json`): grid params plus per-position `grid_ix` / `grid_iy` /
`x_cm` / `y_cm`. Import accepts v3–v5; a v4 (or earlier) linear scan maps onto a one-row
grid (`hCount = numPositions`, `hStep = stepSize`, `vCount = 1`).

**Known limitation:** SAR and the 2D Map still treat the capture sequence as a single line.
With `vCount = 1` that is exactly the old behaviour; with more rows their input is a
zig-zag path and the reconstruction is not meaningful until they are made grid-aware.

## BG Model — Capture Protocol and Findings

**Capture protocol (as of 2026-08-18).** One capture = N sweeps at a **static** standoff
(N configurable in the BG Model panel, default 40, persisted to `localStorage.bgmodel_sweeps`).
Positions are hand-placed and deliberately **irregular**; irregular beats uniform, because
uniform undersampling folds alias energy coherently onto a single wrong spatial frequency
while irregular spacing scatters it. Target: ~30 positions over the widest span the bench
allows (150 mm+).

`bgCaptureStats.computeCaptureStats()` runs at capture completion and stores, per position:
coherent complex mean (`h_mean_real/imag` — this is the training target), per-frequency noise
variance, per-sweep and post-averaging SNR, sweep-pair correlation, standoff mean/std, and
`radarRangeM` (range of the dominant return from the coherent mean, sub-bin interpolated).
`radarRangeM` is **diagnostic only** — nothing consumes it. It exists so the dataset carries an
independent standoff estimate to check the lidar against.

Training now uses **one sample per position** (the coherent mean), not every raw sweep. Replicas
measure the same standoff repeatedly, so feeding them individually adds no information — MSE
regresses to this mean anyway, at N× the epochs.

**Spacing limits** (`spacingLimits()`). An echo with path multiplier α oscillates in standoff
with period `c / (2·f·(α−1))`; worst case is α=3 (triple bounce) at the top of the band. At
5 GHz that period is 15 mm, so:
- ≤ 5 mm gaps — well sampled
- 5–7.5 mm — coarse but unaliased
- Above 7.5 mm — α=3 folds onto a wrong spatial frequency and *corrupts* a fit rather than missing detail

**Span sets echo resolution:** `Δα = c / (2·f_c·span)`. At 3.5 GHz, 85 mm span → Δα = 0.50;
150 mm → 0.29. Widest possible span is the single biggest accuracy lever.

**Export format v2** (`bgmodel_<N>pos_<ts>.json`): hoists `common` (num_steps, step_size,
range_offset) out of the per-sweep repetition and stores per-capture `stats` + column arrays
(`standoffs`, `real`, `imag`). ~7 MB for 30 positions × 40 sweeps. Import accepts v1 and v2 and
backfills stats when absent.

**Analysis of the existing MLP** (1 → 64 → 64 → 302 ReLU, 23,918 params, `bgmodel.worker.js`):
- Output is effectively **rank ~5** — SVD over the input domain puts 96% of energy in 5 PCs,
  in near-equal quadrature pairs (the signature of complex sinusoids in `d`). 19,328 of its
  parameters describe a rank-5 map.
- Only 13/64 first-layer knots land inside the input domain; 32/64 L1 and 17/64 L2 units are
  dead across the whole domain.
- Per-frequency residual magnitude spans **20 dB**, so pooled scalar target normalization makes
  MSE a silently power-weighted loss that starves the weak bins.
- `finalLoss` is training MSE with no held-out split anywhere. Param:data ratio was 0.32:1.
- Inference is 19.3 µs (~52k/s), ~1700× headroom at 30 fps. Sweeps run at 3–6 Hz, so the model
  is nowhere near the bottleneck — **data, not compute, is the constraint.**

**Lidar precision is the hard ceiling.** Two-way phase is `4πfd/c`, so at 5 GHz **1 mm of
standoff error = 12° of phase error**. 20 dB of coherent suppression needs the standoff to
~0.5 mm; the TF-LC02 is a ±few-mm sensor. Comparing `radarRangeM` against `standoffMm` across
the new dataset is the cheap test of whether a radar-derived standoff beats the lidar.

**Result on the 30-position bench set (2026-08-18) — the MLP was replaced.**
Leave-one-position-out suppression, `10*log10(signal/error)` on each held-out position's
measured spectrum, 30 positions over 155.8 mm, median gap 5.5 mm, 15 sweeps each:

| estimator | LOO suppression |
|---|---|
| **Akima interpolation, unwind α=0.80** (shipped) | **20.2 dB** (median 20.3, worst 4.0) |
| cubic spline, α=0.80 | 20.3 dB — best mean, but −12.3 dB on a bad knot |
| physics model, K=5 echoes, free A(f) | 18.7 dB |
| linear interpolation | 12.4 dB |
| Fourier-feature MLP (tanh, k=8..64) | 11.9 dB |
| nearest position | 7.4 dB |
| physics model, K=3, Chebyshev A(f) | 6.8 dB |
| **old 1-64-64-302 MLP** | **4.9 dB** |
| global mean | 0.9 dB |

The captures are dense relative to how fast the background varies, so interpolation wins
outright and needs no parameters. `bgModelInterp.js` ships Akima: it gives up 0.6 dB of mean
for a 16 dB better worst case, because it does not propagate a bad capture into neighbouring
intervals. Inference is 3.1 µs (320k/s, ~10,000× headroom at 30 fps); model file ~360 KB.
Models are `type: 'interp'`; `bgModelInfer.js` keeps the MLP path for previously saved files.

**Things that turned out differently than expected:**
- **The old MLP was underfitting, not overfitting.** 2000 full-batch epochs reached only
  7.97 dB in-sample; 10k → 12.0 dB, 40k → 13.3 dB. Its `finalLoss` looked small only because
  targets were normalized by a single pooled scalar. Its loss curve was still falling 7.4%
  per 100 epochs at epoch 1999. Verified by scoring the saved `models/model 3.json` weights
  directly: 8.6 dB in-sample, matching the numpy re-implementation used for the LOO sweep.
- **The unwind is better with α ≈ 0.80 than α = 1.0** (20.5 dB vs 19.1 dB), a broad plateau
  over 0.70–0.85. Unwinding removes fast phase but injects the lidar's own error into the
  target; 0.8 is the trade-off point. The α matched filter puts the wall echo at 0.93–0.95,
  consistent with the lidar over-reporting standoff *change* by 5–20%. Worth a calibration
  check, but not required — the interpolator absorbs it.
- **The `radarRangeM` diagnostic is unusable**: correlation 0.36 with lidar standoff, 39.9 mm
  scatter after a linear fit. Dominant-peak picking hops between echoes in the near field.
  Radar-derived standoff is not a usable input; the near-field skepticism was correct.
- **Echo structure is dominated by two components**: α≈0.0 (static cable/coupling reflection,
  strongest) and α≈0.93 (wall face, −3.4 dB). Everything else is ≥13 dB down. But a smooth
  (Chebyshev) `A_k(f)` caps the physics model at ~7 dB; with `A_k(f)` free per frequency it
  reaches 18.7 dB. The unmodelled echoes get absorbed into `A_k(f)` as fast frequency
  structure, so `A_k(f)` is *not* smooth.
- **A physics + spline hybrid gives exactly no gain** over the spline alone (20.60 vs 20.59 dB).
- **Measurement noise is not the limit.** The 15-sweep coherent mean sits 47.1 dB below signal.
  Position density is the limit.

**Position density is the dominant lever** (cleaned 22-position set, subsampled):

| median gap | LOO suppression |
|---|---|
| 5.9 mm | 19.3 dB |
| 11.8 mm | 6.9 dB |
| 17.7 mm | −3.3 dB |

Roughly 12 dB lost per doubling of gap. Capture as densely as patience allows; this matters
far more than any modelling choice.

**Range gating cannot separate in-wall targets from the wall face at this bandwidth.** The
entire background sits within 2–6 cm of range, and 3 GHz of bandwidth gives ~50 mm range
resolution. The "gated" metric therefore tracks the full-band metric closely. Separating a
target from the face needs more bandwidth or aperture, not better background subtraction.

## Background subtraction: standoff instrumentation and the false-target hunt (2026-08-28)

Investigating false targets (spurious returns where there is nothing) from the Akima
interpolating background model (`lib/bgModelInterp.js`), which scores 20.2 dB
leave-one-position-out on the bench but misbehaves live.

### `LIDAR_ANTENNA_OFFSET_MM` was 315 mm and that is wrong for this mounting — now 160 mm, and user-editable

**Measured on the bench 2026-08-28:** with the antenna aperture at the wall (true zero
standoff) the TF-LC02 reads **164.83 mm ± 0.68**. So the lidar→antenna offset is ~165 mm,
not 315 mm. The default is now **160 mm** (measured − 5 mm, so a real zero-standoff pose
reports slightly positive rather than negative), it lives in App.jsx state persisted to
`localStorage.lidar_antenna_offset_mm`, and it is editable in the SFCW panel's Standoff
section. **It is a per-mounting quantity — re-measure it after any re-mount** by putting
the aperture against the wall and reading the lidar.

Consequences worth understanding, because they are not all the same:
- A *constant* offset error **cancels exactly** for a model trained and used under that
  same offset: the unwind factor is common to every knot, factors through the linear
  interpolation, and is undone by the rewind. So the wrong 315 did not, by itself, break a
  freshly-trained model — which is consistent with the reported observation that fresh
  models fail the same way. Do not expect fixing the offset alone to fix false targets.
- What it *did* break is every standoff number being unphysical (150 mm behind the actual
  aperture), and any model built under a *different* offset being silently mis-indexed.
  `models/4th model.json` has knots spanning 11–167 mm; under the 315 offset the operating
  standoff is `lidar − 315`, and since the lidar reads ~165–315 mm in real use, that is
  −150…0 mm — **entirely below the model's span, so it clamped on every single sweep**,
  subtracting a background measured somewhere the rig never goes. That is a genuine
  false-target mechanism, and it was completely invisible: `inferInterpModel` clamps
  silently and the live SFCW path had no span check at all.

**The brief's premise that the operating range is 326–482 mm was wrong**, and so was the
claim that the earlier 164 mm noise characterization was "measured at the wrong distance".
164 mm *is* the zero-standoff position. Real operation is lidar ≈ **165–315 mm**.

### Phase 0 — instrumentation (no compensation math was changed)

`pi/sensors/stream.py`:
- `lidar_poll_loop` is capped at `LIDAR_POLL_HZ = 20` (was uncapped, measured **584 Hz** for
  a sensor whose internal measurement only updates at ~11–17 Hz). `--lidar-rate 0` restores
  the old uncapped behaviour for comparison. Measured effect: broadcast rate unchanged
  (48.79 → 48.35 Hz), IMU update rate unchanged/slightly better (**32.66 → 33.83 Hz**).
- Packet now carries `lidar_seq` (increments per *successful read*) and `lidar_ts`. At
  20 Hz the seq sequence seen by a client is contiguous — every reading reaches a packet.

`App.jsx`:
- `lidarAccumRef` dedupes by `lidar_seq` before averaging. Measured against live packets:
  **13.01 → 5.27** accumulated samples per 250 ms sweep. Without this, `lidar_std` would be
  fiction (repeats deflate the spread) and readings would be weighted by how long they
  happened to be held.
- Every sweep record, C-scan cell and BG-model sample now carries `lidar_n`, `lidar_std`,
  `lidar_offset_mm`, `roll_deg`, `pitch_deg` via one shared `provenance` object, so the
  three record types cannot drift apart. Pose is tilt-from-gravity (accel is body-frame
  [forward, left, up]); no yaw, which gravity cannot observe.
- `processedSfcwResult` became `sfcwProcessed = { result, diag }`. Every path that declines
  to subtract now reports a reason, the out-of-span/clamp case is detected and reported
  (matching `CscanPanel.jsx`), and a running clamp fraction is kept. The SFCW panel shows
  "BG applied: YES / YES (CLAMPED) / NO" plus the reason — **"a model is loaded" and "the
  model was applied" are different statements** and only the second is now visible.
- Models record a `geometry` stamp (`lidarAntennaOffsetMm`, full `sfcwParams`, `builtAt`)
  in `bgmodel.worker.js`; the panel warns visibly when a loaded model's stamp disagrees
  with current settings, and says so distinctly for pre-stamp models where it cannot tell.

### Phase 1.1 — LiDAR noise across the real operating range

`pi/sensors/lidar_noise_char.py` (keepable tool). 40 s per distance, 584 Hz polling,
**100% valid reads (`error_code=0`) at every distance**, 1 mm quantisation:

| lidar reads | σ(τ=250 ms, one sweep) | internal update | autocorr half-life | raw σ |
|---|---|---|---|---|
| 164.8 mm (standoff 0) | **0.396 mm** | 17.2 Hz | 37 ms | 0.68 mm |
| 261.7 mm (standoff ~100) | **0.433 mm** | 11.5 Hz | 45 ms | 0.66 mm |
| 339.7 mm (standoff ~180) | **0.560 mm** | 11.5 Hz | 58 ms | 0.78 mm |

σ degrades only mildly with distance. Averaging follows σ ∝ τ^−0.12…−0.30, far shallower
than white noise's τ^−0.5, and plateaus by ~2 s — so **longer averaging does not rescue
it**; there is a correlated/drift floor around 0.15–0.33 mm.

### Phase 1.2 — the oracle test says this is NOT standoff-limited

Reconstructed the 29 training spectra from `models/4th model.json` by rewinding its stored
unwound knots, then for each position built a leave-one-out model and searched standoff
over ±15 mm (0.05 mm grid; ±15 mm is the unambiguous window, two-way λ/2 at 5 GHz = 30 mm)
for the standoff maximising suppression. The numpy port reproduces the browser's own stored
LOO numbers to **1.1e-14 dB**, so the port is not the variable.

- Suppression at the recorded lidar standoff: **20.22 dB** mean.
- Suppression at the *oracle* standoff: **23.19 dB** mean. **The oracle buys only 3.0 dB.**
- `d_oracle − d_lidar` is **zero-mean** (−0.10 mm, σ 1.88 mm, t = −0.30 on 28 df) with no
  trend against position (r = −0.26). No constant bias → not a geometry/offset error at
  capture depth. No drift → not thermal/mechanical creep.

The ±1.88 mm scatter is **not** lidar error: these knots are 40-sweep coherent means whose
standoffs average to σ ≈ 0.05 mm, and a genuine 1.9 mm standoff error would cap suppression
at ~8 dB, not the 20 dB actually observed. The oracle offset is a free parameter absorbing
*model* error, not recovering a true standoff.

**Measured standoff sensitivity is far gentler than the analytic single-echo table**, which
is the key physical result. Deliberately offsetting the inference standoff by ε (LOO, real
data, mean over 29 positions):

| ε | 0.25 mm | 0.5 mm | 1 mm | 2 mm | 3 mm | 5 mm | 10 mm |
|---|---|---|---|---|---|---|---|
| analytic (single echo, α=0.93) | 26.2 | 20.2 | 14.2 | 8.2 | 4.8 | 0.6 | −4.4 |
| **measured** | **19.9** | **19.5** | **18.5** | **15.8** | **13.3** | **9.6** | **4.2** |

The reason is in CLAUDE.md's own echo decomposition: the **dominant** background component
sits at **α ≈ 0 — a static cable/coupling reflection that does not depend on standoff at
all** (confirmed here: the background range-profile peak sits at 0.53–0.54 m and moves by
σ 0.022 m across a 156 mm standoff span, i.e. it does not move). Only the weaker α ≈ 0.93
wall face is standoff-sensitive. So the analytic table, which assumes *all* energy is at
α = 0.93, is structurally pessimistic — **do not use it to predict suppression.** The
SFCW panel deliberately shows no suppression-ceiling tile for this reason: an early draft
had one and it pointed straight at the wrong suspect. Only σ and n are shown, as
measurements rather than predictions.

Monte-Carlo over the real data, adding Gaussian standoff noise at inference:

| σ | 0.05 | 0.25 | 0.43 | 1.0 | 2.0 | 5.0 mm |
|---|---|---|---|---|---|---|
| suppression | 20.19 | 19.99 | **19.74** | 18.80 | 16.78 | 12.58 dB |

At the measured per-sweep σ = 0.43 mm the penalty is **0.5 dB**, not the predicted ~15 dB.

**Where the residual actually goes (the false-target mechanism).** The LOO residual peaks
at −21 dB relative to the background peak, with peak/rms ≈ 5.0 (a flat noise-like residual
gives 3–4; a discrete false target gives ≫10). Its location clusters in two places: right
at the background peak (0.51–0.66 m) and a short-range group at 0.07–0.12 m. At the larger
standoffs the residual peak sits 8–12 cm *beyond* the background peak — and since
subtraction removes the true wall return, that residual becomes the largest feature left on
screen. So the false targets are **the model's own incompletely-cancelled wall/coupling
residual, re-ranked to the top by the subtraction**, not a standoff-noise artifact.

### Phase 1.3 — the regime gap is 5.3 dB, and standoff owns 0.4 dB of it

Fresh 24-position set captured 2026-08-28 under the corrected 160 mm offset
(`data/bgmodel_pass1.json`, gitignored): span 101.2 mm, **median gap 4.1 mm** (inside the
≤5 mm "well sampled" band), 40 sweeps each, SNR 21.3 dB/sweep, pose stable to ±0.04°.
Per-sweep standoff scatter within a static capture measured **0.388 mm**, independently
confirming Phase 1.1's σ(250 ms) of 0.40–0.43 mm.

Four scorings on the same data (`scratchpad/regime_gap.py`), each one step closer to what
live operation actually does:

| | spectrum | standoff | mean suppression |
|---|---|---|---|
| A | 40-sweep mean | capture mean | **24.27 dB** ← what `evaluateLoo` reports |
| B | 40-sweep mean | per-sweep | 23.90 dB |
| C | single sweep | capture mean | 19.11 dB |
| D | single sweep | per-sweep | **18.99 dB** ← what live operation gets |

**Regime gap D−A = 5.3 dB, not the predicted ~15 dB.** Decomposed: standoff noise costs
**0.37 dB** (A−B), single-sweep measurement noise costs **5.16 dB** (A−C). The 0.37 dB
matches the Phase 1.2 Monte-Carlo prediction of 0.48 dB at this σ. **The leading hypothesis
is falsified on both counts** — the gap is 3× smaller than predicted and the mechanism it
named contributes almost none of it. C is bounded by per-sweep SNR itself (21.3 dB): no
subtraction of a single sweep can beat its own noise floor, whatever the model does.

### The actual false-target mechanism: querying the model OUTSIDE its captured span

This is the finding that matters. On the fresh set, leave-one-out splits cleanly by whether
the held-out position is bracketed by other knots:

- **interior (interpolated): 25.98 dB** mean, worst 19.35
- **endpoints (clamped): 5.43 dB** mean
- **penalty for being outside the span: 20.55 dB**

How fast it falls off just past the edge (query below the model's lowest knot, scored
against the nearest real capture):

| outside by | 1 mm | 2 mm | 5 mm | 10 mm | 20 mm | 40 mm |
|---|---|---|---|---|---|---|
| suppression | 20.6 dB | 14.6 dB | 6.8 dB | 1.1 dB | **−3.5 dB** | **−5.2 dB** |

Negative means **the subtraction adds more energy than it removes** — it manufactures a
return where there is nothing. That is the false-target mechanism, and `inferInterpModel`
enters it silently: it clamps to the nearest knot and returns a confident-looking spectrum.

**Why this fired constantly with the old 315 mm offset.** Standoff = `lidar − offset`. The
lidar reads ~165–315 mm in real operation (measured), so under offset 315 every live query
was `−150…0 mm`, while `models/4th model.json` spans 11–167 mm. **Every single sweep was
clamped, by 11 to 161 mm** — i.e. essentially always in the energy-adding regime of the
table above. A model trained under a *different* mounting is the case where the otherwise
exact offset cancellation does not apply.

Note this also explains why *freshly* trained models failed the same way, which had been
taken as ruling the geometry out: a fresh model trained and used under the same offset does
cancel, but it only covers the span the operator actually swept. Pressing the aperture
closer than the nearest training knot puts the query outside the span at the near edge,
where 5 mm already costs 19 dB. Span coverage, not offset, is the thing to check.

**Residual shape confirms it.** On interior positions of the fresh set the residual sits
−28 dB below the background peak with peak/rms **2.58** — genuinely noise-like (a discrete
false target would be ≫10). So a correctly-queried model leaves no false target at all.

**Verdict: not standoff-limited, and not really model-limited either — span-limited.**
Ranked by cost: clamping outside the span **20.6 dB**, single-sweep SNR **5.2 dB**,
standoff noise **0.4 dB**. Chasing lidar precision would buy at most a few tenths of a dB.

### Phase 2 — the live traverse (2026-08-28): span-clamp CONFIRMED, but the model went stale

`span_confirm.py --seconds 120` -> `data/span_confirm_20260828-161212.json`, 377 sweeps,
267 in span / 110 outside, scored against `bgmodel_pass1.json` by `span_analyze.py`.

| bin | n | measured | Phase 1 offline LOO | resid pk/rms |
|---|---|---|---|---|
| in span | 267 | **8.14 dB** | 25.98 | 2.39 |
| 0-1 mm out | 7 | 9.40 | 20.6 | 1.77 |
| 1-2 mm out | 16 | 8.91 | 14.6 | 1.87 |
| 2-5 mm out | 7 | 7.22 | 6.8 | 2.50 |
| 5-10 mm out | 22 | 5.21 | 1.1 | 2.53 |
| 10-20 mm out | 2 | -0.55 | -3.5 | 2.50 |
| >20 mm out | 56 | **-3.32** | | 2.46 |

**Span-clamp mechanism confirmed live.** Suppression falls monotonically with distance
outside the span and goes *negative* past 10 mm — the subtraction adds more energy than it
removes, exactly as Phase 1 predicted offline (-3.32 measured vs -3.5 predicted at >20 mm).
Phase 1's central claim survives contact with live data.

**But no discrete false target was reproduced.** Residual peak/rms is 1.77-2.53 in *every*
bin, in span and far outside it alike — flat, noise-like, never the >>10 that marks a
phantom. So the out-of-span regime degrades suppression and injects energy broadband; this
traverse did not show it manufacturing a discrete peak. The original symptom is still not
reproduced live. Do not treat the false-target mechanism as fully closed.

**The 8.14 dB in-span is a STALE MODEL, not a new mechanism.** Ruled out in order:

- *Not geometry/offset.* Sweeping an inference-standoff offset over +/-20 mm peaks at
  **+3.3 mm for 8.76 dB** — 0.62 dB over doing nothing. Same shape as Phase 1.2's oracle
  test: the free standoff parameter absorbs model error, it does not recover a true standoff.
- *Not configuration.* Training and traverse `sfcwParams` are identical field-for-field
  (2000-5000 MHz, 60 MHz step, tx1/rx1 50/25, tx2/rx2 50/25, settle 10, buffers 4) and both
  ran at `lidarAntennaOffsetMm = 160`.
- *Not hand motion during the traverse.* A plausible confound, since the traverse moves
  while the training captures were static, and a sweep that moves mid-sweep smears its own
  frequency-vs-phase relationship. Stratifying the 267 in-span sweeps by `lidar_std` (a
  motion proxy) kills it: stillest quartile (0.35 mm, effectively static) gives **8.06 dB**,
  fastest quartile (2.12 mm) gives **8.01 dB** — indistinguishable. Whatever costs the
  17.8 dB is present even when the rig is holding still, so it is not a motion artifact.
- *Not the measurement.* Traverse-vs-traverse at <0.5 mm separation gives **17.96 dB,
  coherence 0.9914** (n=1031 pairs) — today's sweeps predict each other well, and 17.96 dB
  matches Phase 1.3's regime-D single-sweep figure of 18.99 dB. The radar is fine.
- *It is the training set.* Traverse-vs-training complex coherence is **0.9338**, and
  `-10*log10(1-rho^2)` for rho=0.9338 is **8.93 dB** — essentially the 8.14 dB observed. The
  measured spectrum has decorrelated from the trained background by ~6.6% of its energy.
  Per-step `|h|` ratio now/training runs **0.60 to 2.17 (mean 1.267)** — strongly
  frequency-dependent, so not a gain change.

**Most likely cause: the bench was physically disturbed between the two sessions.**
`bgmodel_pass1.json` was captured 00:38; the traverse ran at 16:12, after a day of bladeRF
USB troubleshooting (repeated replugging, power cycles, a move to a USB 2.0 port and back,
FPGA reloads). CLAUDE.md's own echo decomposition says the *dominant* background component
is the alpha ~ 0 static cable/coupling reflection — precisely the term that moving cables and
connectors changes. A frequency-dependent 0.6-2.2x amplitude change is what a re-seated
connector or shifted cable dress looks like.

**Operational consequence: a background model has a shelf life bounded by the bench staying
untouched.** Any RF cable, connector, or antenna disturbance invalidates it, and the failure
is silent — the model still interpolates confidently and still reports "BG applied: YES".
Retrain after any hardware work, and treat a sudden in-span suppression drop as a staleness
signal rather than a modelling problem. Cheap staleness check, no recapture needed: score
traverse-vs-traverse coherence against traverse-vs-model coherence; if the first is ~0.99
and the second is well below it, the model is stale, not wrong.

### Phase 3 — fresh model closes the staleness gap (2026-08-28)

Two 30-position sets captured 5 min apart (`bgmodel_pass2_*`, `bgmodel_pass3_*`, 15 sweeps
each, span 5-160 mm), then the traverse re-run against pass3.

**Shelf life measured for the first time.** Cross-session scoring (build from A, score on B's
measured spectra, interior only):

| model -> data | elapsed | suppression |
|---|---|---|
| pass2 -> pass3 | ~5 min | **21.21 dB** |
| pass3 -> pass2 | ~5 min | **21.35 dB** |
| pass1 -> pass2/3 | ~16 h | **7.90 / 8.76 dB** |

The ~8 dB at 16 h independently reproduces the traverse's 8.14 dB against pass1 by a
different route, confirming that shortfall was staleness. **Caveat: two time points are not
a curve** — this cannot yet distinguish gradual drift from a step change caused by the day's
bladeRF USB/FPGA work in between, and those imply very different retraining cadences. Leaving
a model overnight with the bench untouched and re-scoring would separate them.

**Live traverse against the fresh model: in span 8.14 -> 17.70 dB.** Falloff outside the span
confirmed again (-3.45 dB at >20 mm out vs -3.5 predicted). 17.70 dB combines single-sweep SNR (21.7 dB) with
cross-session model error (~21 dB) for a predicted 18.4 dB, which matches.

**Corrected 2026-08-28 — in-span is MODEL limited, not SNR limited.** Measured directly by
coherently averaging K consecutive sweeps of an 87-sweep static capture: K=1 gives 19.28 dB,
K=16 gives 21.95 dB — **+2.83 dB against an ideal +12.0**, plateauing at ~22 dB. Averaging
removes only the sweep-noise term; what remains is the model floor. So sweep noise is worth
~3 dB of the total and no more, and **raising `num_buffers` cannot buy more than that same
~3 dB** while costing sweep rate. The plateau (~22 dB) sits right at pass3's own LOO
(23.57 dB), so the binding constraint is **interpolation error at the achieved knot density**,
not background drift over minutes and not the estimator choice.

**Do not merge capture sessions.** Merging pass2+pass3 (51 knots, 3.3 mm median gap) scores
22.40 dB mean — *worse* than pass3 alone (23.57). The density gain is cancelled by the 21 dB
inter-session disagreement being injected into the interpolation. Even 5 minutes of elapsed
time is enough that combining sessions does not pay.

**Hand-placement scatter costs 6-7 dB and is now the largest capture-side lever.** The
scheduler asked for 3.8-6.8 mm gaps; pass2 achieved 0.6-13.7 mm. Held-out positions in the
tightest third of brackets scored 24.37 dB vs 17.14 dB in the widest third (pass2), 26.31 vs
20.46 (pass3). `capture_bgmodel.py --span-lo/--span-hi` now prints a per-position target, but
its move window still counts down blindly and captures wherever the operator happens to be —
gating capture on `|error| < 2 mm` would recover most of that.

**The false target has still never been reproduced** — but see the target A/B below: the
peak/rms metric used to reach that statement is now known to be incapable of detecting a
target at all, so this conclusion carries no weight and needs redoing with the magnitude-vs-
reference detector. **A separate remaining hypothesis
is the display, not the physics:** in the 0-30 cm window the residual's dynamic range is
**23.1 dB vs the raw profile's 20.6 dB**, so a dynamic colour scale stretches flat post-
subtraction noise across the full colormap exactly as it did real structure beforehand. Test
it by pinning `sfcwScaleRange` to manual at the pre-subtraction limits and seeing whether the
"targets" survive.

### Target A/B (2026-08-28): peak/rms is not a target detector, and what is

Static bed, standoff ~24 mm, target placed then removed with nothing else changed. 126 sweeps
with, 87 without, ~7 min apart, both scored against `bgmodel_pass3`.

**The target is unambiguous**: magnitude change **+4.4 dB peaked at 21.2 cm**, against a
**0.23 dB** noise floor measured in the 0-10 cm wall/coupling region, which the target leaves
completely undisturbed. Complex signature is 19.3 dB above the coherent-mean noise floor.

**Both detection statistics in use scored it BELOW target-free background:**

| | target present | target-free |
|---|---|---|
| residual peak/rms | **1.52** | 1.75-1.91 |
| peak excess over median | **3.80 dB** | 6.36-8.37 dB |

A target that is extended by range resolution (~50 mm at 3 GHz) plus sidelobes lifts the
residual *floor* rather than spiking one bin. peak/rms is self-normalised, so a raised floor
raises the RMS and the ratio falls. **Any self-referential peakiness measure is blind to a
real target, and blind in the wrong direction.** Do not use peak/rms, or excess-over-median,
to decide whether something is there.

**What works: magnitude range profile vs a target-free reference at matched standoff.**
Calibrated threshold from this data: a magnitude change **> ~0.7 dB** (3x the 0.23 dB control
region) indicates a target.

**The LiDAR has a slow ZERO-DRIFT of ~1 mm over minutes, and within-capture noise statistics
are blind to it.** The lidar reported the standoff moving 1.03 mm between the two target A/B
captures. It had not: range-gating the complex difference to the wall/coupling region (0-10 cm)
gives **-40.1 dB**, where an actual 1.03 mm move would give **-14.0 dB** -- 26 dB below, i.e. the
true geometry held to **~0.05 mm** while the lidar's reading wandered by a millimetre. Use the
wall-gate phase, not the lidar, to decide whether the rig moved; the radar is ~20x the better
position sensor at this scale.

Independently confirmed on the training sets: a constant-bias search across the pass2/pass3
cross-session pair wants **-1.35 mm** one way and **+1.45 mm** the other. Equal-and-opposite is
the signature of a real zero-drift between sessions, not a fitting artifact.

**Cost is real but modest: ~2 dB** (pass2->pass3 21.21 -> 23.15 dB when the bias is corrected).
Far less than the single-echo table predicts for 1.4 mm (14 dB) because the dominant background
term is the alpha~0 static coupling, which does not depend on standoff at all -- the same reason
Phase 1.2's measured falloff was much gentler than the analytic one. A 1-parameter bias search
at inference is therefore a cheap ~2 dB, and being a slowly-tracked global constant it cannot
absorb a target the way a per-sweep standoff search could.

**This does NOT explain the staleness.** The same search on the 16 h pair (pass1->pass3) recovers
only **+0.69 dB**, so the overnight decorrelation is genuine background change, not lidar drift.

**Magnitude and complex tolerate very different amounts of this.** The magnitude range profile
was unaffected -- the 0-10 cm control stayed at 0.23 dB whether or not the standoffs were
matched -- because a sub-millimetre shift is a small fraction of a range bin. The complex
difference is not: at the (spurious) 1.03 mm the shift term would have swamped the target. So
**target detection can use magnitude and tolerate ~1 mm of standoff error; background
subtraction needs coherent cancellation and is sensitive to it.**

**Without compensation the target sits 16.6 dB below the wall return** (-51.4 vs -34.8 dB) --
a small bump on the skirt of a much larger feature, which is precisely the case background
subtraction exists to fix.

### Tooling added

- `pi/sensors/lidar_noise_char.py` — noise vs averaging window at a given distance.
- `pi/radar/capture_bgmodel.py` — captures a `bgmodel_training_data` v2 set headlessly
  (same format the BG Model panel exports, plus per-sweep `lidar_n`/`lidar_std`/pose
  columns). **The SDR socket must be drained continuously**: `sfcw_start` free-runs, so a
  move window that does not read the socket lets sweeps pile up, and the capture then
  drains the backlog with several sweeps sharing one instant — every standoff after the
  first came back `None` in the first version. The reader task now pairs each sweep with
  the lidar samples that arrived since the previous one, at arrival time.
- `pi/radar/bgmodel_interp.py` — numpy port of `bgModelInterp.js` + `rangeProfile.js`
  (build / infer / range profile / LOO). Reproduces the browser's own numbers exactly on
  `data/bgmodel_pass1.json`: interior LOO 25.98 dB mean / 19.35 worst, clamped 5.43 dB.
  It deliberately preserves `inferInterpModel`'s asymmetry — interpolating at the
  *clamped* standoff while rewinding phase at the *unclamped* one — because that is the
  failure being measured; a "tidier" port would not reproduce it. Written because
  CLAUDE.md's reference to `scratchpad/regime_gap.py` is dead (that file was in a session
  scratchpad and no longer exists), so the port now lives in the repo instead.
- `pi/radar/span_confirm.py` + `pi/radar/span_analyze.py` — **live** confirmation of the
  span-clamp mechanism, which Phase 1 established only offline (its own caveat: "I never
  observed a false target live in the app"). `span_confirm.py` records a continuous
  standoff traverse through and past both span edges — **aim at a blank wall**, the method
  rests on every residual peak being false by construction. `span_analyze.py` applies the
  model at each sweep's own standoff and bins suppression + residual peak/rms by
  mm-outside-span, against Phase 1's offline falloff (1 mm → 20.6 dB, 5 → 6.8, 20 → −3.5).
  `span_analyze.py` reports residual **peak/rms**, which is NOT a target detector — see the
  target A/B below. It is only a coarse "is the residual spiky" indicator; do not read a low
  value as absence of a target.

## RF Calib panel gains are NOT the SFCW sweep's gains (2026-08-25)

Easy to conflate since both transmit the same 100 kHz-offset CW tone (`set_waveform('cw',
offset=100_000, ...)`), but they carry **independent** gain state. RF Calib panel drives
`BladeRFDriver.tx_gain`/`rx_gain` directly (defaulting to 50 dB / 25 dB — see the RF Calib
defaults change above). `SFCWEngine._configure_hardware()` (`sfcw_engine.py:443-450`)
overwrites those same driver fields from its own `tx1_gain`/`rx1_gain`/`tx2_gain`/`rx2_gain`
and `amplitude=0.9` right before every sweep — these are set **independently** in both
`App.jsx` (`sfcwParams.tx1Gain`/`rx1Gain`) and `sfcw_engine.py`'s own `__init__` defaults,
and must be kept in sync manually; there's no shared source between the two.

**Verified 2026-08-25: user bench-tested the RF Calib panel at 60 dB TX / 90% amplitude /
40 dB RX (SFCW's gain point at the time) per the recommendation below, and confirmed the
result acceptable.** SFCW's own `tx1_gain`/`rx1_gain` defaults were then dropped from
60/40 to **50/25** (both `App.jsx` `sfcwParams` and `SFCWEngine.__init__`) to match the RF
Calib panel's defaults, since 50/25 was the tested-good operating point. `tx2_gain`/
`rx2_gain` (reference channel) were untouched. If SFCW's gains are ever changed again,
retest via the RF Calib panel at the *exact* new tx1/rx1 numbers first — testing at
whatever the RF Calib panel happens to default to does not characterize the sweep unless
the two are known to match, which is why they were brought into alignment here.

**Why harmonics of that 100 kHz tone (seen on the RF Calib panel's live FFT as spurs at
odd multiples — ~3×, ~5× — of the 100 kHz offset, tens of dB down) mostly don't reach the
SFCW range profile.** The RF Calib panel's FFT is a wideband capture — it shows everything
in the passband, harmonics included. `SFCWEngine._sweep_core` (`sfcw_engine.py:598-601`)
never does a wideband FFT at all: it demodulates by multiplying the raw RX IQ against
`exp(-j*2*pi*cw_offset*t)` and taking the mean over n=4096 samples — a single-frequency-bin
coherent extraction (matched filter) at exactly the 100 kHz reference frequency, not a
spectrum. Bin spacing at n=4096/10 Msps is ~2.44 kHz; a harmonic ~200-400 kHz away sits
roughly 80-165 bins off-target, which a rectangular-window single-bin DFT rejects by very
roughly another 45-55 dB beyond whatever level it already sits at in the wideband FFT. That
headroom is why the specific spurs found on the RF Calib panel are not expected to be a
first-order concern for h_cal quality — confirmed adequate at the 60/90/40 bench test above.

**What can actually corrupt h_cal, and isn't checked in software:** (1) TX compression at
the fundamental itself (100 kHz offset) — amplitude/phase nonlinearity right at the
frequency being measured isn't filtered out by the coherent extraction the way a harmonic
is, though it partially cancels through the `h_signal / h_reference` ratio if TX1/TX2
compress similarly; (2) RX ADC clipping from RX gain pushed too high — confirmed by grep,
there is no clipping/saturation check anywhere in `sfcw_engine.py` or `bladerf_driver.py`
(`_process_h_cal`'s phase-coherence check catches retune-timing corruption, not amplitude
clipping). Both are real, unguarded failure modes; the odd-harmonic spurs from the RF Calib
panel are, by contrast, structurally rejected by the demod and a lower-priority concern.
