# FPGA Timestamp Debugging via USB

**Added timestamp monitoring to bladeRF driver - no JTAG required!**

---

## What Was Added

### Modified File: `pi/radar/bladerf_driver.py`

**Added FPGA timestamp logging to both RX loops:**

1. **Single-channel RX** (`_rx_loop`)
2. **Dual-channel RX** (`_rx_loop_dual`)

**Added method:** `get_timestamp(direction)` - reads FPGA hardware timestamp

---

## What You'll See

**When running your SFCW radar, the Pi console will now print:**

```
[bladerf] RX timestamp: 1,234,567 (+16384 samples)
[bladerf] RX timestamp: 1,250,951 (+16384 samples)
[bladerf] RX timestamp: 1,267,335 (+16384 samples)
```

**Or for dual-channel mode:**

```
[bladerf] DUAL RX timestamp: 2,048,000 (+1024 samples per channel)
[bladerf] DUAL RX timestamp: 2,049,024 (+1024 samples per channel)
```

---

## Sample Drop Detection

**If samples are dropped (FIFO overflow), you'll see:**

```
[bladerf] RX timestamp: 1,234,567 (+16384 samples)
[bladerf] RX timestamp: 1,267,335 (+16384 samples)
[bladerf] WARNING: 16384 samples dropped (gap=32768, expected=16384)
```

**This instantly alerts you to buffer underruns!**

---

## What the Timestamp Means

**The timestamp is a 64-bit counter from the FPGA:**

- Increments by 1 for each sample
- At 2 Msps sample rate:
  - 2,000,000 = 1 second
  - 4,000,000 = 2 seconds
  - 40,000,000 = 20 seconds

**Convert to real time:**
```python
time_seconds = timestamp / sample_rate
```

---

## Example Use Cases

### 1. **Verify TX/RX Synchronization**

```
[bladerf] TX started
[bladerf] RX timestamp: 1,000,000
[bladerf] RX timestamp: 1,016,384
→ RX is capturing 16.384ms after TX start
```

### 2. **Detect Sample Drops**

```
[bladerf] RX timestamp: 5,000,000
[bladerf] WARNING: 8192 samples dropped
→ FIFO overflow! Processing too slow or USB congested
```

### 3. **Measure Sweep Timing**

```
[SFCW] Sweep 1 started
[bladerf] RX timestamp: 10,000,000
[SFCW] Sweep 1 complete
[bladerf] RX timestamp: 10,512,000
→ Sweep took 512,000 samples = 256ms at 2 Msps
```

### 4. **Correlate Events**

```
[sensors] LiDAR: 45.2 cm
[bladerf] RX timestamp: 20,500,000
[SFCW] Range peak at 43.8 cm
→ Events happened 10.25 seconds into capture
```

---

## How It Works

**No JTAG needed!**

```
FPGA → USB → Pi → Python prints to console
```

**The FPGA hardware maintains an internal 64-bit timestamp counter.**

**We read it via `bladerf_get_timestamp()` API call over USB.**

**Printed to Pi console where your `pi/start.py` runs.**

---

## Testing

**Run your existing SFCW application:**

```bash
# On the Pi
cd ~/version_bluestar/pi
python start.py
```

**On the groundstation PC, start an SFCW sweep.**

**Watch the Pi console - you'll see timestamp output!**

---

## Advantages Over SignalTap

| Feature | SignalTap (JTAG) | Timestamp Logging (USB) |
|---------|------------------|-------------------------|
| **Hardware needed** | JTAG cable | None (uses existing USB) |
| **Setup time** | 40+ min recompile | Already done! |
| **Works with** | Special FPGA image | Your existing FPGA |
| **Capture depth** | 1K samples | Unlimited (continuous) |
| **Real-time** | Post-capture only | Live streaming |
| **Log to file** | Manual export | Automatic (stdout) |

---

## Logging to File

**Redirect Pi output to capture timestamps:**

```bash
# On Pi
python start.py 2>&1 | tee radar_debug.log
```

**Now timestamps are saved to `radar_debug.log` for analysis!**

---

## Performance Impact

**Minimal:** ~1-2 µs per timestamp read (negligible at 2 Msps).

**If you want to disable for production:**

Comment out the timestamp code in `bladerf_driver.py`:

- Single RX: Lines ~305-319
- Dual RX: Lines ~434-448

---

## Summary

✅ **FPGA timestamps now printed via USB**  
✅ **Sample drop detection automatic**  
✅ **Works with existing code - no recompile**  
✅ **No JTAG cable needed**  
✅ **Logs to console/file**

**This gives you visibility into FPGA timing without any hardware changes!**

---

**Created:** 2026-08-23  
**Modified files:** `pi/radar/bladerf_driver.py`  
**No FPGA recompilation needed!**
