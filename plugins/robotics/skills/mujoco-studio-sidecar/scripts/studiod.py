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
"""MuJoCo Studio Web daemon for agent-driven live simulation.

Launches `mujoco.studio.launch_web` with hot-reload on the simulation scene and
workspace plugins (`sim_plugin.py` / `viewer_plugin.py`), Studio's built-in step
control and history plugins, and the daemon helpers in `studiod/plugins.py`.

Usage:
  - In a monorepo workspace: run target `...prod/plugins/robotics:studiod`
  - Standalone Python: `python3 studiod.py --workspace_dir=<dir>` (see `--help`)

This script shares its name with the `studiod/` package next to it. That is
fine because the script is only ever executed (as `__main__`), never imported:
inside it, `from studiod import ...` resolves to the package, which Python
prefers over a same-named module. When a plugin archive bundler strips empty
`__init__.py` files, the startup bootstrap registers `studiod/` in
`sys.modules` explicitly so `studiod.py` never shadows `studiod/`.
"""

from collections.abc import Sequence
import importlib.util
import logging
import os
import pathlib
import sys
import time
import traceback
import types
from typing import Any

# Hermetic Python launchers do not add the script's directory to `sys.path`,
# and `mujoco-studio-sidecar` contains hyphens so `studiod/` cannot be
# imported by a workspace-rooted dotted path.
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
  sys.path.insert(0, _SCRIPTS_DIR)

# Marketplace zip bundlers may strip empty `__init__.py` files, which would demote
# `studiod/` to a namespace package shadowed by `studiod.py` itself.
_STUDIOD_PKG_DIR = os.path.join(_SCRIPTS_DIR, 'studiod')
if (
    'studiod' not in sys.modules
    and os.path.isdir(_STUDIOD_PKG_DIR)
    and not os.path.isfile(os.path.join(_STUDIOD_PKG_DIR, '__init__.py'))
):
  _studiod_pkg = types.ModuleType('studiod')
  _studiod_pkg.__path__ = [_STUDIOD_PKG_DIR]
  _studiod_pkg.__package__ = 'studiod'
  sys.modules['studiod'] = _studiod_pkg

from studiod import discovery  # pylint: disable=g-import-not-at-top
from studiod import options  # pylint: disable=g-import-not-at-top
from studiod import scaffold  # pylint: disable=g-import-not-at-top

if __name__ == '__main__' and any(
    arg in ('-h', '--help') for arg in sys.argv[1:]
):
  options.parse_daemon_options()

try:
  from mujoco.studio import app as studio_app  # pylint: disable=g-import-not-at-top
  from mujoco.studio import launch_web  # pylint: disable=g-import-not-at-top
  from mujoco.studio import plugin  # pylint: disable=g-import-not-at-top
  from mujoco.studio import sim_history  # pylint: disable=g-import-not-at-top
  from mujoco.studio import step_control  # pylint: disable=g-import-not-at-top
  from mujoco.studio import viewer_handle  # pylint: disable=g-import-not-at-top
  from mujoco.studio import viewer_protocol  # pylint: disable=g-import-not-at-top
except ModuleNotFoundError as exc:
  if exc.name == 'mujoco' or (exc.name or '').startswith('mujoco.'):
    try:
      has_legacy_exp_studio = (
          importlib.util.find_spec('mujoco.experimental.studio') is not None
      )
    except (ModuleNotFoundError, ValueError):
      has_legacy_exp_studio = False
    if has_legacy_exp_studio:
      raise SystemExit(
          f'[studiod] Missing `mujoco.studio` ({exc}); found legacy '
          '`mujoco.experimental.studio` (3.x). Do NOT alias or bridge it via '
          '`.pth` or `sitecustomize` startup imports (which can trigger '
          'recursive `glfw` subprocess spawning on startup). Install '
          'MuJoCo 4.0.1+ into a clean environment:\n'
          '  pip install --upgrade "mujoco>=4.0.1"'
      ) from exc
    raise SystemExit(
        f'[studiod] Missing `mujoco.studio` ({exc}). Install MuJoCo 4.0.1+ '
        'into this Python environment:\n'
        '  pip install --upgrade "mujoco>=4.0.1"'
    ) from exc
  raise

from studiod import control  # pylint: disable=g-import-not-at-top
from studiod import plugins as daemon_plugins  # pylint: disable=g-import-not-at-top
from studiod import state  # pylint: disable=g-import-not-at-top

logger = logging.getLogger(__name__)


def _load_workspace_plugins(
    workspace_dir: pathlib.Path, daemon_state: state.DaemonState
) -> list[plugin.Plugin]:
  """Loads `sim_plugin.py` and `viewer_plugin.py` using `plugin.load_plugins`."""
  loaded: list[plugin.Plugin] = []
  if str(workspace_dir) not in sys.path:
    sys.path.insert(0, str(workspace_dir))
  for comp in ('sim_plugin', 'viewer_plugin'):
    py_path = workspace_dir / f'{comp}.py'
    if not py_path.is_file():
      continue
    try:
      loaded.extend(plugin.load_plugins([py_path]))
      daemon_state.record_status(comp, ok=True, error=None)
    except Exception:  # pylint: disable=broad-exception-caught
      tb = traceback.format_exc()
      logger.error('Failed to load %s:\n%s', py_path, tb)
      daemon_state.record_status(comp, ok=False, error=tb)
  return loaded


def main(argv: Sequence[str] | None = None) -> None:
  """Runs the studiod WebViewer + control server loop."""
  opts = options.parse_daemon_options(argv)
  workspace_dir = discovery.resolve_workspace_dir(opts.workspace_dir)
  if opts.scaffold:
    created = scaffold.scaffold_workspace(workspace_dir, opts.scene_file)
    if created:
      print(
          f'[studiod] Scaffolded {created} in {workspace_dir}', flush=True
      )

  session_paths = discovery.default_session_paths(opts.session_file)
  discovery.shutdown_previous_daemon_if_running(session_paths)

  handle_ref: list[viewer_handle.ViewerHandle | None] = [None]
  sim_plugin_ref: list[daemon_plugins.DaemonSimPlugin | None] = [None]
  control_port_holder: list[int] = [0]

  def _notify_sidecar(
      event_type: str, extra: dict[str, Any] | None = None
  ) -> None:
    notify_url = discovery.discover_sidecar_notify_url(
        opts.sidecar_notify_url, isolated_session=bool(opts.session_file)
    )
    if not notify_url:
      return
    payload: dict[str, Any] = {
        'event': event_type,
        'pid': os.getpid(),
        'http_port': daemon_state.wait_for_viewer_http_port(timeout=0.05),
        'control_port': control_port_holder[0],
        'workspace_dir': str(daemon_state.workspace_dir),
        'runtime_dir': str(daemon_state.runtime_dir),
        'status_file': str(daemon_state.status_file),
        'snapshot_file': str(daemon_state.snapshot_file),
        'scene_source': daemon_state.scene_source_name(),
    }
    if extra:
      payload.update(extra)
    notify_token = discovery.discover_sidecar_notify_token(
        opts.sidecar_notify_url, isolated_session=bool(opts.session_file)
    )
    notify_headers = (
        {'X-Studio-Notify-Token': notify_token} if notify_token else None
    )
    discovery.post_json(
        notify_url, payload, timeout=0.5, headers=notify_headers
    )

  runtime_dir = state.default_runtime_dir(workspace_dir, opts.runtime_dir)
  daemon_state = state.DaemonState(
      workspace_dir=workspace_dir,
      scene_file=opts.scene_file,
      runtime_dir=runtime_dir,
      on_context_captured=lambda snap: _notify_sidecar(
          'context_captured', {'timestamp': snap.get('timestamp')}
      ),
      on_status_changed=lambda status: _notify_sidecar(
          'status_changed', {'ok': status.get('ok', True)}
      ),
  )

  unsubscribe_hot_reload = state.subscribe_hot_reload_status(
      state.make_hot_reload_status_listener(daemon_state)
  )

  server, actual_control_port = control.start_control_server(
      daemon_state,
      handle_ref,
      sim_plugin_ref,
      control_port=opts.control_port,
  )
  control_port_holder[0] = actual_control_port

  daemon_sim_plugin = daemon_plugins.DaemonSimPlugin(daemon_state)
  sim_plugin_ref[0] = daemon_sim_plugin
  daemon_viewer_plugin = daemon_plugins.DaemonViewerPlugin(
      daemon_state, compact_ui=opts.compact_ui
  )
  user_plugins = _load_workspace_plugins(workspace_dir, daemon_state)
  hot_reload_spec = ','.join(
      ['model', *(type(p).__name__ for p in user_plugins)]
  )
  config = viewer_protocol.ViewerConfig(
      title='MuJoCo Studio',
      gfx='web',
      http_port=opts.http_port,
      open_browser=opts.open_browser,
      hot_reload=hot_reload_spec,
  )
  app_config = studio_app.Config(
      show_options=not opts.compact_ui,
      show_inspector=not opts.compact_ui,
  )
  session_published = False

  try:
    with launch_web.launch(
        config,
        plugins=[
            studio_app.App(app_config),
            daemon_viewer_plugin,
            daemon_sim_plugin,
            step_control.StepControl(),
            sim_history.SimHistory(),
            *user_plugins,
        ],
    ) as handle:
      handle_ref[0] = handle
      viewer_http_port = daemon_state.wait_for_viewer_http_port(
          timeout=10.0, is_alive_fn=handle.is_running
      )
      if not handle.is_running() or viewer_http_port <= 0:
        raise RuntimeError(
            'WebViewer failed to start or bind an HTTP port '
            f'(is_running={handle.is_running()}, '
            f'http_port={viewer_http_port}).'
        )
      session_payload = {
          'pid': os.getpid(),
          'http_port': viewer_http_port,
          'control_port': actual_control_port,
          'workspace_dir': str(daemon_state.workspace_dir),
          'runtime_dir': str(daemon_state.runtime_dir),
          'status_file': str(daemon_state.status_file),
          'snapshot_file': str(daemon_state.snapshot_file),
          'scene_source': daemon_state.scene_source_name(),
          'started_at': time.time(),
          'auto_open_pane': True,
      }
      discovery.write_session_files(session_paths, session_payload)
      session_published = True
      _notify_sidecar('session_started', session_payload)
      print(
          f'[studiod] Ready: WebViewer=http://127.0.0.1:{viewer_http_port}'
          f' Control=http://127.0.0.1:{actual_control_port}'
          f' Workspace={daemon_state.workspace_dir}'
          f' Runtime={daemon_state.runtime_dir}',
          flush=True,
      )

      if opts.headless_test_steps > 0:
        for _ in range(opts.headless_test_steps):
          if not handle.is_running():
            break
          handle.sync()
      else:
        viewer_handle.run_sim_loop(handle)
  finally:
    if session_published:
      if not opts.session_file or opts.headless_test_steps <= 0:
        discovery.remove_session_files(session_paths, pid=os.getpid())
      _notify_sidecar(
          'session_stopped',
          {'http_port': 0, 'control_port': 0},
      )
    unsubscribe_hot_reload()
    server.shutdown()
    server.server_close()


if __name__ == '__main__':
  main()
