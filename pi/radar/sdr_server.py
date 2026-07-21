"""WebSocket server for bladeRF SDR control and IQ streaming (port 9003)."""

import asyncio
import json
import sys
import numpy as np
import websockets

from bladerf_driver import BladeRFDriver
from sfcw_engine import SFCWEngine

SCALE = 2047
PORT = 9003
VIS_FPS = 25
FFT_SIZE = 16384
VIS_SAMPLES = 512


class SDRServer:
    def __init__(self):
        self.driver = BladeRFDriver()
        self.sfcw = SFCWEngine(self.driver)
        self.clients = set()
        self.rx_queue = asyncio.Queue(maxsize=4)
        self.sfcw_queue = asyncio.Queue(maxsize=8)
        self._broadcast_task = None
        self._sfcw_broadcast_task = None

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
                if 'tx1_gain' in cmd:
                    params['tx1_gain'] = int(cmd['tx1_gain'])
                if 'rx1_gain' in cmd:
                    params['rx1_gain'] = int(cmd['rx1_gain'])
                if 'tx2_gain' in cmd:
                    params['tx2_gain'] = int(cmd['tx2_gain'])
                if 'rx2_gain' in cmd:
                    params['rx2_gain'] = int(cmd['rx2_gain'])
                if 'range_offset' in cmd:
                    params['range_offset'] = float(cmd['range_offset'])
                self.sfcw.set_params(**params)
                await self._broadcast_sfcw_status()

            elif action == 'sfcw_start':
                if self.driver.tx_running:
                    self.driver.stop_tx()
                if self.driver.rx_running:
                    self.driver.stop_rx()
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

        except Exception as e:
            await ws.send(json.dumps({'type': 'error', 'message': str(e)}))

    def _get_sfcw_status(self):
        params = self.sfcw.get_params()
        params['running'] = self.sfcw.running
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
                if 'phase_coherence' in data:
                    result_msg['phase_coherence'] = data['phase_coherence']
                msg = json.dumps(result_msg)
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
