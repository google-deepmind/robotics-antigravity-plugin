# Copyright 2026 DeepMind Technologies Limited
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Loopback HTTP control API used by the agent and the Node sidecar."""

import http.server
import json
import threading
from typing import Any
import urllib.parse

from mujoco.studio import viewer_handle
from studiod import state


def start_control_server(
    daemon_state: state.DaemonState,
    handle_ref: list[viewer_handle.ViewerHandle | None],
    sim_plugin_ref: list[Any],
    control_port: int = 0,
) -> tuple[http.server.ThreadingHTTPServer, int]:
  """Starts a loopback HTTP server exposing status, context, and reload APIs."""

  class ControlHandler(http.server.BaseHTTPRequestHandler):
    """Handles local HTTP requests from the agent or Node sidecar."""

    def log_message(self, fmt: str, *args: Any) -> None:
      del fmt, args

    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
      body = json.dumps(payload, indent=2).encode('utf-8')
      self.send_response(status_code)
      self.send_header('Content-Type', 'application/json')
      self.send_header('Content-Length', str(len(body)))
      self.end_headers()
      self.wfile.write(body)

    def _reject_browser_origin(self) -> bool:
      """Rejects browser-originated requests.

      This API is only ever called by the local agent and by the Node
      sidecar (which strips `Origin` when proxying, see
      `proxyHttpToPort` in `sidecars/mujoco_studio/main.mjs`). Browsers
      always send an `Origin` header on cross-origin requests, so any
      request carrying one is a website talking directly to the loopback
      port — e.g. after a localhost port scan — and must not be able to
      shut down or reload the simulation.
      """
      if 'Origin' in self.headers:
        self._send_json(403, {'error': 'Browser-origin requests rejected'})
        return True
      return False

    def _read_json_body(self) -> dict[str, Any]:
      length = int(self.headers.get('Content-Length', '0') or '0')
      if length <= 0:
        return {}
      raw = self.rfile.read(length)
      try:
        return json.loads(raw.decode('utf-8'))
      except json.JSONDecodeError:
        return {}

    def do_OPTIONS(self) -> None:  # pylint: disable=invalid-name
      self._send_json(200, {'ok': True})

    def do_GET(self) -> None:  # pylint: disable=invalid-name
      """Serves `/_studio/status` and `/_studio/context` GET endpoints."""
      if self._reject_browser_origin():
        return

      parsed = urllib.parse.urlparse(self.path)
      if parsed.path in ('/_studio/status', '/status'):
        status = daemon_state.get_status()
        viewer_port = daemon_state.wait_for_viewer_http_port(timeout=0.05)
        status['viewer_http_port'] = viewer_port
        status['http_port'] = viewer_port
        status['daemon_connected'] = viewer_port > 0
        self._send_json(200, status)
        return
      if parsed.path in ('/_studio/context', '/context'):
        handle = handle_ref[0]
        params = urllib.parse.parse_qs(parsed.query)
        fresh = params.get('fresh', ['0'])[0] in ('1', 'true', 'yes')
        snap = {} if fresh else daemon_state.get_latest_snapshot()
        if (
            not snap
            and handle is not None
            and handle.model is not None
            and handle.data is not None
        ):
          snap = daemon_state.capture_context_snapshot(
              handle.model, handle.data
          )
        self._send_json(200, snap)
        return
      self._send_json(404, {'error': f'Unknown endpoint: {parsed.path}'})

    def do_POST(self) -> None:  # pylint: disable=invalid-name
      """Handles capture, reload, and shutdown POST endpoints."""
      if self._reject_browser_origin():
        return

      parsed = urllib.parse.urlparse(self.path)
      body = self._read_json_body()
      handle = handle_ref[0]

      if parsed.path in (
          '/_studio/context/capture',
          '/_studio/capture',
          '/capture',
      ):
        note = str(body.get('note', 'Triggered via HTTP control API'))
        if (
            handle is not None
            and handle.model is not None
            and handle.data is not None
        ):
          snap = daemon_state.capture_context_snapshot(
              handle.model,
              handle.data,
              event=state.RequestContextSnapshotEvent(note=note),
          )
          self._send_json(200, {'ok': True, 'snapshot': snap})
        else:
          self._send_json(503, {'ok': False, 'error': 'Simulation not ready'})
        return

      if parsed.path in ('/_studio/reload', '/reload'):
        sim_helper = sim_plugin_ref[0]
        if sim_helper is not None:
          sim_helper.reload_scene(preserve_state=True)
        elif handle is not None:
          handle.reload()
        self._send_json(200, {'ok': True, 'status': daemon_state.get_status()})
        return

      if parsed.path in ('/_studio/shutdown', '/shutdown'):
        if handle is not None:
          handle._is_running = False  # pylint: disable=protected-access
        self._send_json(200, {'ok': True})
        return

      self._send_json(404, {'error': f'Unknown endpoint: {parsed.path}'})

  server = http.server.ThreadingHTTPServer(
      ('127.0.0.1', control_port), ControlHandler
  )
  actual_port = int(server.server_address[1])
  thread = threading.Thread(
      target=server.serve_forever, name='studiod-control', daemon=True
  )
  thread.start()
  return server, actual_port
