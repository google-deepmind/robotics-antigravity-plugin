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
"""Port-free discovery between the daemon, the Node sidecar, and the agent.

The daemon and sidecar start independently on free ports and find each other
through small JSON files in a per-user temp location.
"""

from collections.abc import Sequence
import getpass
import json
import logging
import os
import pathlib
import re
import sys
import tempfile
import threading
import time
from typing import Any
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

WORKSPACE_DIR_PREFIX = 'mujoco_studio_'

_LOOPBACK_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def resolve_workspace_dir(
    explicit_dir: str = '',
    *,
    cwd: str | os.PathLike[str] | None = None,
    home: pathlib.Path | None = None,
) -> pathlib.Path:
  """Resolves the simulation workspace folder from flags, env, or active CWD.

  An omitted `--workspace_dir` defaults to the active working directory (or
  `~/mujoco_studio_default` when invoked directly from `~`). A bare name such
  as `--workspace_dir=harness` that does not exist under the working directory
  resolves to `~/mujoco_studio_harness`.

  Args:
    explicit_dir: Value of `--workspace_dir`, or empty to deduce automatically.
    cwd: Optional working directory override for tests.
    home: Optional home directory override for tests.

  Returns:
    Resolved `pathlib.Path` for the simulation workspace folder.
  """
  home_dir = (
      pathlib.Path(os.path.abspath(home))
      if home is not None
      else pathlib.Path.home()
  )
  raw_cwd = (
      os.fspath(cwd)
      if cwd is not None
      else (os.environ.get('BUILD_WORKING_DIRECTORY', '') or os.getcwd())
  )
  invoking_dir = pathlib.Path(os.path.abspath(raw_cwd))

  raw = explicit_dir or os.environ.get('MUJOCO_STUDIO_WORKSPACE_DIR', '')
  if not raw:
    if invoking_dir.resolve() == home_dir.resolve():
      return (home_dir / f'{WORKSPACE_DIR_PREFIX}default').resolve()
    return invoking_dir.resolve()

  expanded = pathlib.Path(raw).expanduser()
  if expanded.is_absolute():
    return pathlib.Path(os.path.abspath(expanded)).resolve()

  is_bare_name = (
      os.sep not in raw
      and (os.altsep is None or os.altsep not in raw)
      and raw not in ('.', '..')
  )
  if is_bare_name and not (invoking_dir / raw).exists():
    folder = (
        raw
        if raw.startswith(WORKSPACE_DIR_PREFIX)
        else f'{WORKSPACE_DIR_PREFIX}{raw}'
    )
    return (home_dir / folder).resolve()

  return (invoking_dir / expanded).resolve()


def _sanitize_uid_tag(raw: str) -> str:
  cleaned = re.sub(r'[^a-zA-Z0-9_.-]', '_', raw.strip().lower())
  return cleaned or 'default'


def _safe_getuser() -> str:
  try:
    return getpass.getuser()
  except Exception:  # pylint: disable=broad-exception-caught
    return ''


def uid_tag() -> str:
  """Returns a stable per-user tag for session and sidecar temp files."""
  getuid = getattr(os, 'getuid', None)
  if callable(getuid):
    try:
      return str(getuid())
    except AttributeError:
      pass
  raw = (
      os.environ.get('USERNAME')
      or os.environ.get('USER')
      or _safe_getuser()
      or 'default'
  )
  return _sanitize_uid_tag(raw)


def candidate_uid_tags() -> list[str]:
  """Returns UID tags to check when reading or writing shared temp files.

  On POSIX, `os.getuid()` is canonical. On Windows (`os.getuid` absent),
  different shells (PowerShell/cmd vs Git Bash/MSYS2) may populate `USERNAME`,
  `USER`, or neither, so discovery checks all plausible tags in priority order.
  """
  primary = uid_tag()
  getuid = getattr(os, 'getuid', None)
  if callable(getuid):
    try:
      getuid()
      return [primary]
    except AttributeError:
      pass
  tags = [primary]
  for raw in (
      os.environ.get('USERNAME', ''),
      os.environ.get('USER', ''),
      _safe_getuser(),
      'default',
  ):
    if not raw:
      continue
    for candidate in (_sanitize_uid_tag(raw), raw.strip()):
      if candidate and candidate not in tags:
        tags.append(candidate)
  return tags


def _safe_is_file(path: pathlib.Path) -> bool:
  """Checks `path.is_file()` without failing under OS sandbox restrictions."""
  try:
    return path.is_file()
  except OSError:
    return False


def is_windows() -> bool:
  """Returns True when running on Windows."""
  return os.name == 'nt' or sys.platform.startswith('win')


def _candidate_shared_tmp_dirs() -> list[pathlib.Path]:
  """Returns OS temp directories to search (`tempfile.gettempdir()` + `/tmp`)."""
  primary = pathlib.Path(tempfile.gettempdir())
  dirs = [primary]
  if is_windows():
    return dirs
  slash_tmp = pathlib.Path('/tmp')
  try:
    same = primary.resolve() == slash_tmp.resolve()
  except OSError:
    same = str(primary) == '/tmp'
  if not same:
    dirs.append(slash_tmp)
  return dirs


def default_session_paths(explicit_path: str = '') -> list[pathlib.Path]:
  """Returns the candidate `session.json` paths shared with the Node sidecar.

  An explicit `--session_file` is the only path: it must not also publish to
  (or shut down the daemon registered in) the shared per-user file, which is
  what tests and private runs use the flag to avoid.

  Args:
    explicit_path: Value of `--session_file`, or empty for the defaults.
  """
  if explicit_path:
    return [pathlib.Path(explicit_path)]
  paths: list[pathlib.Path] = []
  plugin_data = os.environ.get('PLUGIN_DATA', '')
  if plugin_data:
    paths.append(pathlib.Path(plugin_data) / 'session.json')
  exec_data = os.environ.get('ANTIGRAVITY_EXECUTABLE_DATA_DIR', '')
  if exec_data:
    paths.append(pathlib.Path(exec_data) / 'session.json')
  for tmp_dir in _candidate_shared_tmp_dirs():
    for tag in candidate_uid_tags():
      candidate = tmp_dir / f'mujoco_studio_session_{tag}.json'
      if candidate not in paths:
        paths.append(candidate)
  return paths


def default_sidecar_info_path() -> pathlib.Path:
  """Returns the primary path where `main.mjs` publishes its sidecar port."""
  explicit = os.environ.get('MUJOCO_STUDIO_SIDECAR_FILE', '')
  if explicit:
    return pathlib.Path(explicit)
  return (
      pathlib.Path(tempfile.gettempdir())
      / f'mujoco_studio_sidecar_{uid_tag()}.json'
  )


def candidate_sidecar_info_paths() -> list[pathlib.Path]:
  """Returns candidate paths where `main.mjs` may publish its sidecar port."""
  explicit = os.environ.get('MUJOCO_STUDIO_SIDECAR_FILE', '')
  if explicit:
    return [pathlib.Path(explicit)]
  paths: list[pathlib.Path] = []
  plugin_data = os.environ.get('PLUGIN_DATA', '')
  if plugin_data:
    paths.append(pathlib.Path(plugin_data) / 'sidecar.json')
  exec_data = os.environ.get('ANTIGRAVITY_EXECUTABLE_DATA_DIR', '')
  if exec_data:
    paths.append(pathlib.Path(exec_data) / 'sidecar.json')
  for tmp_dir in _candidate_shared_tmp_dirs():
    for tag in candidate_uid_tags():
      candidate = tmp_dir / f'mujoco_studio_sidecar_{tag}.json'
      if candidate not in paths:
        paths.append(candidate)
  return paths


def discover_sidecar_notify_url(
    explicit_url: str = '', *, isolated_session: bool = False
) -> str:
  """Resolves the sidecar `/_studio/notify` URL from flags or sidecar info."""
  if explicit_url:
    return explicit_url
  if isolated_session:
    return ''
  best_port = 0
  best_started_at = -1.0
  for info_path in candidate_sidecar_info_paths():
    if not _safe_is_file(info_path):
      continue
    try:
      data = json.loads(info_path.read_text(encoding='utf-8'))
      port = int(data.get('web_port', 0))
      started_at = float(
          data.get('started_at', 0) or info_path.stat().st_mtime
      )
      if port > 0 and started_at >= best_started_at:
        best_started_at = started_at
        best_port = port
    except Exception:  # pylint: disable=broad-exception-caught
      continue
  if best_port > 0:
    return f'http://127.0.0.1:{best_port}/_studio/notify'
  return ''


def discover_sidecar_notify_token(
    explicit_url: str = '', *, isolated_session: bool = False
) -> str:
  """Returns the per-process notify token published by the sidecar.

  Mirrors `discover_sidecar_notify_url`: the token lives in the same sidecar
  info files. An explicit notify URL or an isolated session has no token
  file, so this returns '' and the sidecar falls back to the legacy
  (no-Origin, no-token) path.
  """

  if explicit_url or isolated_session:
    return ''

  best_token = ''
  best_started_at = -1.0

  for info_path in candidate_sidecar_info_paths():
    if not _safe_is_file(info_path):
      continue

    try:
      data = json.loads(info_path.read_text(encoding='utf-8'))
      token = str(data.get('notify_token', '') or '')
      started_at = float(
          data.get('started_at', 0) or info_path.stat().st_mtime
      )

      if token and started_at >= best_started_at:
        best_started_at = started_at
        best_token = token
    except Exception:  # pylint: disable=broad-exception-caught
      continue

  return best_token


def post_json(
    url: str,
    payload: dict[str, Any],
    timeout: float = 1.0,
    headers: dict[str, str] | None = None,
) -> bool:
  """Sends a best-effort JSON POST request and returns True on HTTP 2xx."""
  if not url:
    return False
  try:
    body = json.dumps(payload).encode('utf-8')
    all_headers = {'Content-Type': 'application/json'}
    if headers:
      all_headers.update(headers)
    req = urllib.request.Request(
        url,
        data=body,
        headers=all_headers,
        method='POST',
    )
    parsed = urllib.parse.urlparse(url)
    opener = (
        _LOOPBACK_OPENER
        if parsed.hostname in ('127.0.0.1', 'localhost', '::1')
        else urllib.request.build_opener()
    )
    with opener.open(req, timeout=timeout) as resp:
      return 200 <= resp.status < 300
  except Exception:  # pylint: disable=broad-exception-caught
    return False


def shutdown_previous_daemon_if_running(
    session_paths: Sequence[pathlib.Path],
) -> None:
  """Stops any previously running studiod so ports/sessions don't clash."""
  for path in session_paths:
    if not _safe_is_file(path):
      continue
    try:
      data = json.loads(path.read_text(encoding='utf-8'))
      old_pid = int(data.get('pid', 0))
      old_control_port = int(data.get('control_port', 0))
      if old_pid and old_pid != os.getpid() and old_control_port > 0:
        post_json(
            f'http://127.0.0.1:{old_control_port}/_studio/shutdown',
            {'reason': 'Superseded by new studiod instance'},
            timeout=1.0,
        )
        time.sleep(0.15)
    except Exception:  # pylint: disable=broad-exception-caught
      continue


def atomic_write_text(path: pathlib.Path, content: str) -> None:
  """Atomically writes UTF-8 text to `path`, tolerating Windows file locks."""
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp = path.parent / f'.{path.name}.{os.getpid()}.{threading.get_ident()}.tmp'
  try:
    tmp.write_text(content, encoding='utf-8')
    last_err: OSError | None = None
    for attempt in range(5):
      try:
        tmp.replace(path)
        return
      except OSError as exc:
        last_err = exc
        time.sleep(0.01 * (attempt + 1))
    # On Windows, NTFS may deny os.replace while a reader holds a handle open;
    # fall back to an in-place write so status/session updates are not lost.
    try:
      path.write_text(content, encoding='utf-8')
    except OSError as exc:
      if last_err is not None:
        raise last_err from exc
      raise
  finally:
    try:
      if tmp.exists():
        tmp.unlink()
    except OSError:
      pass


def write_session_files(
    session_paths: Sequence[pathlib.Path], session_payload: dict[str, Any]
) -> None:
  serialized = json.dumps(session_payload, indent=2)
  for path in session_paths:
    try:
      atomic_write_text(path, serialized)
    except OSError:
      logger.debug('Could not write session file %s', path, exc_info=True)


def remove_session_files(
    session_paths: Sequence[pathlib.Path], *, pid: int | None = None
) -> None:
  """Removes session files owned by `pid` (or unconditionally if `pid` is None)."""
  for path in session_paths:
    if not _safe_is_file(path):
      continue
    try:
      if pid is not None:
        data = json.loads(path.read_text(encoding='utf-8'))
        if int(data.get('pid', 0)) != pid:
          continue
      path.unlink(missing_ok=True)
    except Exception:  # pylint: disable=broad-exception-caught
      logger.debug('Could not remove session file %s', path, exc_info=True)
