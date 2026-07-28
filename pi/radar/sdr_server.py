"""WebSocket server for bladeRF SDR control and IQ streaming (port 9003)."""

import asyncio
import json
import sys
import time
import numpy as np
import websockets

from bladerf_driver import BladeRFDriver
from sfcw_engine import SFCWEngine
from fmcw_engine import FMCWEngine

SCALE = 2047
PORT = 9003
VIS_FPS = 25
FFT_SIZE = 16384
VIS_SAMPLES = 512


def _json_default(obj):
    """Handle numpy types in JSON serialization."""
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


class SDRServer:
    def __init__(self):
        self.driver = BladeRFDriver()
        self.sfcw = SFCWEngine(self.driver)
        self.fmcw = FMCWEngine(self.driver)
        self.sweep_mode = 'sfcw'  # 'sfcw' or 'fmcw'
        self.clients = set()
        self.rx_queue = asyncio.Queue(maxsize=4)
        self.sfcw_queue = asyncio.Queue(maxsize=8)
        self._broadcast_task = None
        self._sfcw_broadcast_task = None
        self._hwcal_mode = None
        self._hwcal_step_size_cm = None

    async def start(self):
        try:
            self.driver.open()
        except Exception as e:
            print(f"[sdr] ERROR: Could not open bladeRF device: {e}")
            print("[sdr] Check that the bladeRF is connected and drivers are installed.")
            sys.exit(1)

        print(f"[sdr] Device: {self.driver.serial}")
        print(f"[sdr] Starting WebSocket server on port {PORT}")
        self._broadcast_task = asyncio.create_task(self._broadcast_loop())
        self._sfcw_broadcast_task = asyncio.create_task(self._sfcw_broadcast_loop())
        async with websockets.serve(self._handler, "0.0.0.0", PORT):
            await asyncio.Future()

    async def _handler(self, ws):
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({'type': 'status', **self.driver.get_status()}))
            await ws.send(json.dumps({'type': 'sfcw_status', **self._get_sfcw_status()}))
            await ws.send(json.dumps({'type': 'fmcw_status', **self._get_fmcw_status()}))
            await ws.send(json.dumps({'type': 'sweep_mode', 'mode': self.sweep_mode}))
            async for msg in ws:
                await self._dispatch(ws, json.loads(msg))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    async def _dispatch(self, ws, cmd):
        action = cmd.get('cmd')
        try:
            if action == 'start_tx':
                self.driver.start_tx()
                await self._broadcast_status()
            elif action == 'stop_tx':
                self.driver.stop_tx()
                await self._broadcast_status()
            elif action == 'start_rx':
                self.driver.start_rx(self._rx_callback)
                await self._broadcast_status()
            elif action == 'stop_rx':
                self.driver.stop_rx()
                await self._broadcast_status()
            elif action == 'set_freq':
                self.driver.set_frequency(float(cmd['value']) * 1e6)
                await self._broadcast_status()
            elif action == 'set_tx_gain':
                self.driver.set_tx_gain(int(cmd['value']))
                await self._broadcast_status()
            elif action == 'set_rx_gain':
                self.driver.set_rx_gain(int(cmd['value']))
                await self._broadcast_status()
            elif action == 'set_sample_rate':
                self.driver.set_sample_rate(float(cmd['value']) * 1e6)
                await self._broadcast_status()
            elif action == 'set_waveform':
                params = {}
                if 'offset_khz' in cmd:
                    params['offset'] = float(cmd['offset_khz']) * 1e3
                if 'amplitude' in cmd:
                    params['amplitude'] = float(cmd['amplitude'])
                if 'chirp_bw_khz' in cmd:
                    params['chirp_bw'] = float(cmd['chirp_bw_khz']) * 1e3
                if 'chirp_duration_ms' in cmd:
                    params['chirp_duration'] = float(cmd['chirp_duration_ms']) / 1000
                self.driver.set_waveform(cmd.get('type', 'cw'), **params)
                await self._broadcast_status()
            elif action == 'get_status':
                await ws.send(json.dumps({'type': 'status', **self.driver.get_status()}))

            # SFCW commands
            elif action == 'sfcw_set_params':
                params = {}
                if 'start_freq_mhz' in cmd:
                    params['start_freq'] = float(cmd['start_freq_mhz']) * 1e6
                if 'stop_freq_mhz' in cmd:
                    params['stop_freq'] = float(cmd['stop_freq_mhz']) * 1e6
                if 'step_size_mhz' in cmd:
                    params['step_size'] = float(cmd['step_size_mhz']) * 1e6
                if 'settle_time_ms' in cmd:
                    params['settle_time'] = float(cmd['settle_time_ms']) / 1000
                if 'num_buffers' in cmd:
                    params['num_buffers'] = int(cmd['num_buffers'])
                if 'range_offset' in cmd:
                    params['range_offset'] = float(cmd['range_offset'])
                if 'max_display_range' in cmd:
                    params['max_display_range'] = float(cmd['max_display_range'])
                if 'blank_range' in cmd:
                    params['blank_range'] = float(cmd['blank_range'])
                if 'coherent_avg' in cmd:
                    params['coherent_avg'] = int(cmd['coherent_avg'])
                needs_restart = self.sfcw.running and any(
                    k in params for k in ('start_freq', 'stop_freq', 'step_size')
                )
                self.sfcw.set_params(**params)
                if needs_restart:
                    self.sfcw.stop()
                    self.sfcw.start(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_start':
                if self.fmcw.running:
                    self.fmcw.stop()
                self._stop_all_streams()
                await self._broadcast_status()
                self.sfcw.start(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_stop':
                self.sfcw.stop()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_capture_bg':
                self.sfcw.capture_background()

            elif action == 'sfcw_clear_bg':
                self.sfcw.clear_background()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_capture_ref':
                self.sfcw.capture_reference()

            elif action == 'sfcw_clear_ref':
                self.sfcw.clear_reference()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_clear_all':
                self.sfcw.clear_all_subtraction()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_mean_enable':
                self.sfcw.enable_mean_subtraction()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_mean_disable':
                self.sfcw.disable_mean_subtraction()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_mean_reset':
                self.sfcw.reset_mean()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_generate_table':
                if self.sfcw.running:
                    self.sfcw.stop()
                self._stop_all_streams()
                await self._broadcast_status()
                self.sfcw.generate_gain_table(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_verify_table':
                if self.sfcw.running:
                    self.sfcw.stop()
                self._stop_all_streams()
                await self._broadcast_status()
                self.sfcw.verify_gain_table(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_reload_table':
                self.sfcw._load_gain_table()
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_get_status':
                await ws.send(json.dumps({'type': 'sfcw_status', **self._get_sfcw_status()}))

            # B-Scan commands — single-shot sweeps using current SFCW params
            elif action == 'bscan_capture':
                if self.sfcw.running:
                    self.sfcw.stop()
                    await self._broadcast_sfcw_status()
                if self.driver.tx_running:
                    self.driver.stop_tx()
                if self.driver.rx_running:
                    self.driver.stop_rx()
                await self._broadcast_status()
                self.sfcw.run_single(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'bscan_capture_bg':
                self.sfcw.capture_background()
                if self.sfcw.running:
                    self.sfcw.stop()
                    await self._broadcast_sfcw_status()
                if self.driver.tx_running:
                    self.driver.stop_tx()
                if self.driver.rx_running:
                    self.driver.stop_rx()
                await self._broadcast_status()
                self.sfcw.run_single(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'bscan_clear_bg':
                self.sfcw.clear_background()

            # Hardware calibration commands
            elif action == 'hwcal_capture':
                mode = cmd.get('mode')
                if mode not in ('cable_thru', 'free_space', 'per_position'):
                    await ws.send(json.dumps({'type': 'error', 'message': f'Invalid calibration mode: {mode}'}))
                    return
                step_size_cm = cmd.get('step_size_cm')
                # Stop any running sweep/TX/RX
                if self.sfcw.running:
                    self.sfcw.stop()
                    await self._broadcast_sfcw_status()
                if self.driver.tx_running:
                    self.driver.stop_tx()
                if self.driver.rx_running:
                    self.driver.stop_rx()
                await self._broadcast_status()
                self._hwcal_mode = mode
                self._hwcal_step_size_cm = step_size_cm
                self.sfcw.run_calibration(mode, self._hwcal_callback)
                await self._broadcast_sfcw_status()

            elif action == 'hwcal_per_position_new':
                self.sfcw.clear_per_position()
                await ws.send(json.dumps({
                    'type': 'hwcal_status',
                    **self.sfcw.load_calibration_status(),
                }))

            elif action == 'hwcal_per_position_undo':
                self.sfcw.undo_per_position()
                await ws.send(json.dumps({
                    'type': 'hwcal_status',
                    **self.sfcw.load_calibration_status(),
                }))

            elif action == 'hwcal_get_status':
                await ws.send(json.dumps({
                    'type': 'hwcal_status',
                    **self.sfcw.load_calibration_status(),
                }))

            # Sweep mode toggle
            elif action == 'set_sweep_mode':
                mode = cmd.get('mode')
                if mode in ('sfcw', 'fmcw'):
                    # Stop any active sweep before switching
                    if self.sfcw.running:
                        self.sfcw.stop()
                    if self.fmcw.running:
                        self.fmcw.stop()
                    self.sweep_mode = mode
                    await self._broadcast_sfcw_status()

            elif action == 'get_sweep_mode':
                await ws.send(json.dumps({'type': 'sweep_mode', 'mode': self.sweep_mode}))

            # FMCW commands
            elif action == 'fmcw_set_params':
                params = {}
                if 'start_freq_mhz' in cmd:
                    params['start_freq'] = float(cmd['start_freq_mhz']) * 1e6
                if 'stop_freq_mhz' in cmd:
                    params['stop_freq'] = float(cmd['stop_freq_mhz']) * 1e6
                if 'step_size_mhz' in cmd:
                    params['step_size'] = float(cmd['step_size_mhz']) * 1e6
                if 'pll_settle_time_ms' in cmd:
                    params['pll_settle_time'] = float(cmd['pll_settle_time_ms']) / 1000
                if 'num_buffers' in cmd:
                    params['num_buffers'] = int(cmd['num_buffers'])
                if 'tx1_gain' in cmd:
                    params['tx1_gain'] = int(cmd['tx1_gain'])
                if 'rx1_gain' in cmd:
                    params['rx1_gain'] = int(cmd['rx1_gain'])
                if 'range_offset' in cmd:
                    params['range_offset'] = float(cmd['range_offset'])
                needs_restart = self.fmcw.running and any(
                    k in params for k in ('tx1_gain', 'rx1_gain',
                                          'start_freq', 'stop_freq', 'step_size')
                )
                self.fmcw.set_params(**params)
                if needs_restart:
                    self.fmcw.stop()
                    self.fmcw.start(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'fmcw_start':
                if self.sfcw.running:
                    self.sfcw.stop()
                if self.fmcw.running:
                    self.fmcw.stop()
                self._stop_all_streams()
                await self._broadcast_status()
                self.fmcw.start(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'fmcw_stop':
                self.fmcw.stop()
                await self._broadcast_sfcw_status()

            elif action == 'fmcw_capture_bg':
                self.fmcw.capture_background()

            elif action == 'fmcw_clear_bg':
                self.fmcw.clear_background()
                await self._broadcast_sfcw_status()

            elif action == 'fmcw_capture_ref':
                self.fmcw.capture_reference()

            elif action == 'fmcw_clear_ref':
                self.fmcw.clear_reference()
                await self._broadcast_sfcw_status()

            elif action == 'fmcw_clear_all':
                self.fmcw.clear_all_subtraction()
                await self._broadcast_sfcw_status()

            elif action == 'fmcw_get_status':
                await ws.send(json.dumps({'type': 'fmcw_status', **self._get_fmcw_status()}))

            # B-scan with active sweep mode
            elif action == 'sweep_capture':
                if self.sfcw.running:
                    self.sfcw.stop()
                if self.sfcw.running:
                    self.sfcw.stop()
                if self.fmcw.running:
                    self.fmcw.stop()
                    await self._broadcast_sfcw_status()
                self._stop_all_streams()
                await self._broadcast_status()
                if self.sweep_mode == 'fmcw':
                    self.fmcw.run_single(self._sfcw_callback)
                else:
                    self.sfcw.run_single(self._sfcw_callback)
                await self._broadcast_sfcw_status()

            elif action == 'sweep_capture_bg':
                if self.sweep_mode == 'fmcw':
                    self.fmcw.capture_background()
                else:
                    self.sfcw.capture_background()
                if self.sfcw.running:
                    self.sfcw.stop()
                if self.fmcw.running:
                    self.fmcw.stop()
                if self.driver.tx_running:
                    self.driver.stop_tx()
                if self.driver.rx_running:
                    self.driver.stop_rx()
                await self._broadcast_status()
                if self.sweep_mode == 'fmcw':
                    self.fmcw.run_single(self._sfcw_callback)
                else:
                    self.sfcw.run_single(self._sfcw_callback)
                await self._broadcast_sfcw_status()

        except Exception as e:
            await ws.send(json.dumps({'type': 'error', 'message': str(e)}))

    def _stop_all_streams(self):
        """Stop TX/RX in both single and dual channel modes."""
        if self.driver._dual_channel:
            if self.driver.tx_running:
                self.driver.stop_tx_dual()
            if self.driver.rx_running:
                self.driver.stop_rx_dual()
        else:
            if self.driver.tx_running:
                self.driver.stop_tx()
            if self.driver.rx_running:
                self.driver.stop_rx()

    def _get_sfcw_status(self):
        params = self.sfcw.get_params()
        params['running'] = self.sfcw.running
        params['sweep_mode'] = self.sweep_mode
        params['fmcw_running'] = self.fmcw.running
        return params

    def _get_fmcw_status(self):
        params = self.fmcw.get_params()
        params['running'] = self.fmcw.running
        params['sweep_mode'] = self.sweep_mode
        return params

    def _sfcw_callback(self, data):
        try:
            self.sfcw_queue.put_nowait(data)
        except asyncio.QueueFull:
            try:
                self.sfcw_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.sfcw_queue.put_nowait(data)
            except asyncio.QueueFull:
                pass

    def _hwcal_callback(self, data):
        """Callback for hardware calibration sweeps."""
        if isinstance(data, dict) and data.get('type') == 'calibration_raw':
            # Save calibration data to disk
            mode = data['mode']
            self.sfcw.save_calibration(mode, data, step_size_cm=self._hwcal_step_size_cm)
            # Convert to broadcast-friendly format
            h_cal = data['h_complex']
            freqs_ghz = data['frequencies'] / 1e9
            magnitudes_db = 20 * np.log10(np.abs(h_cal) + 1e-12)
            result = {
                'type': 'hwcal_result',
                'mode': mode,
                'frequencies': [round(f, 6) for f in freqs_ghz.tolist()],
                'magnitudes_db': [round(m, 2) for m in magnitudes_db.tolist()],
                'timestamp': data['timestamp'],
            }
            # Also include updated status
            result['status'] = self.sfcw.load_calibration_status()
            try:
                self.sfcw_queue.put_nowait(result)
            except asyncio.QueueFull:
                try:
                    self.sfcw_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    self.sfcw_queue.put_nowait(result)
                except asyncio.QueueFull:
                    pass
        else:
            # Progress messages and errors go through the same queue
            self._sfcw_callback(data)

    async def _sfcw_broadcast_loop(self):
        while True:
            try:
                data = await asyncio.wait_for(self.sfcw_queue.get(), timeout=0.1)
            except asyncio.TimeoutError:
                await asyncio.sleep(0.01)
                continue

            if not self.clients:
                continue

            if isinstance(data, dict) and 'error' in data:
                msg = json.dumps({'type': 'sfcw_error', 'message': data['error']})
            elif isinstance(data, dict) and data.get('type') == 'progress':
                msg = json.dumps({'type': 'sfcw_progress', 'step': data['step'], 'total': data['total'], 'freq_mhz': round(data['freq_mhz'], 2)})
            elif isinstance(data, dict) and data.get('type') == 'range_profile':
                result_msg = {
                    'type': 'sfcw_result',
                    'distances': [round(d, 4) for d in data['distances']],
                    'magnitudes': [round(m, 2) for m in data['magnitudes']],
                    'range_resolution': round(data['range_resolution'], 4),
                    'max_range': round(data['max_range'], 4),
                    'num_steps': data['num_steps'],
                    'timestamp': data['timestamp'],
                }
                if 'peak' in data:
                    result_msg['peak'] = data['peak']
                if 'avg_count' in data:
                    result_msg['avg_count'] = data['avg_count']
                if 'magnitudes_linear' in data:
                    result_msg['magnitudes_linear'] = [round(m, 6) for m in data['magnitudes_linear']]
                if 'phase_coherence' in data:
                    result_msg['phase_coherence'] = data['phase_coherence']
                if 'ref_trace' in data:
                    result_msg['ref_trace'] = [round(m, 2) for m in data['ref_trace']]
                    result_msg['cur_trace'] = [round(m, 2) for m in data['cur_trace']]
                if 'h_cal_real' in data:
                    result_msg['h_cal_real'] = [round(v, 8) for v in data['h_cal_real']]
                    result_msg['h_cal_imag'] = [round(v, 8) for v in data['h_cal_imag']]
                    result_msg['freqs'] = data['freqs']
                msg = json.dumps(result_msg)
            elif isinstance(data, dict) and data.get('type') in ('table_complete', 'verify_complete'):
                msg = json.dumps(data, default=_json_default)
            elif isinstance(data, dict) and data.get('type') == 'hwcal_result':
                msg = json.dumps(data)
            elif isinstance(data, dict) and data.get('type') == 'fmcw_test_result':
                msg = json.dumps(data, default=_json_default)
            elif isinstance(data, dict) and data.get('type') == 'fmcw_status':
                msg = json.dumps(data)
            else:
                continue

            dead = set()
            for client in self.clients:
                try:
                    await client.send(msg)
                except websockets.ConnectionClosed:
                    dead.add(client)
            self.clients -= dead

            if not self.sfcw.running:
                await self._broadcast_sfcw_status()

    async def _broadcast_sfcw_status(self):
        msg = json.dumps({'type': 'sfcw_status', **self._get_sfcw_status()})
        dead = set()
        for client in self.clients:
            try:
                await client.send(msg)
            except websockets.ConnectionClosed:
                dead.add(client)
        self.clients -= dead

    def _rx_callback(self, iq_buffer):
        try:
            self.rx_queue.put_nowait(iq_buffer)
        except asyncio.QueueFull:
            try:
                self.rx_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.rx_queue.put_nowait(iq_buffer)
            except asyncio.QueueFull:
                pass

    async def _broadcast_loop(self):
        interval = 1.0 / VIS_FPS
        while True:
            try:
                iq = await asyncio.wait_for(self.rx_queue.get(), timeout=0.1)
            except asyncio.TimeoutError:
                await asyncio.sleep(0.01)
                continue

            if not self.clients:
                await asyncio.sleep(interval)
                continue

            i_raw = iq[0::2].astype(np.float64)
            q_raw = iq[1::2].astype(np.float64)
            num = len(i_raw)

            vis_len = min(VIS_SAMPLES, num)
            i_vis = i_raw[:vis_len] / SCALE
            q_vis = q_raw[:vis_len] / SCALE

            rx_msg = json.dumps({
                'type': 'rx_data',
                'i': [round(v, 4) for v in i_vis.tolist()],
                'q': [round(v, 4) for v in q_vis.tolist()],
            })

            fft_len = min(num, FFT_SIZE)
            complex_iq = (i_raw[:fft_len] + 1j * q_raw[:fft_len]) / SCALE
            window = np.hanning(fft_len)
            spectrum = np.fft.fftshift(np.fft.fft(complex_iq * window))
            magnitudes = 20 * np.log10(np.abs(spectrum) / fft_len + 1e-12)
            n_bins = 512
            if len(magnitudes) > n_bins:
                trim = len(magnitudes) - len(magnitudes) % n_bins
                magnitudes = magnitudes[:trim].reshape(n_bins, -1).max(axis=1)

            fft_msg = json.dumps({
                'type': 'rx_fft',
                'magnitudes': [round(v, 1) for v in magnitudes.tolist()],
                'freq_span': self.driver.sample_rate,
            })

            dead = set()
            for client in self.clients:
                try:
                    await client.send(rx_msg)
                    await client.send(fft_msg)
                except websockets.ConnectionClosed:
                    dead.add(client)
            self.clients -= dead

            await asyncio.sleep(interval)

    async def _broadcast_status(self):
        msg = json.dumps({'type': 'status', **self.driver.get_status()})
        dead = set()
        for client in self.clients:
            try:
                await client.send(msg)
            except websockets.ConnectionClosed:
                dead.add(client)
        self.clients -= dead


if __name__ == '__main__':
    server = SDRServer()
    asyncio.run(server.start())
