"""Keryx Hermes plugin.

Registers operator-facing CLI and bundled read-only skills only. The plugin
must stay thin; Keryx logic remains in the TypeScript opsctl surface.
"""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path
from typing import Iterable

_PLUGIN_DIR = Path(__file__).resolve().parent
_INSTALL_DIR = Path(__file__).parent

_SKILLS = {
    "keryx-worker": "Execute approved Keryx action-item cards safely.",
    "keryx-collector": "Govern Keryx source collector cron jobs.",
    "keryx-collector-creator": "Design and author new Keryx collectors.",
}


def _candidate_roots() -> Iterable[Path]:
    yield _PLUGIN_DIR.parent
    locator = _INSTALL_DIR / "keryx-root.txt"
    if locator.exists():
        raw = locator.read_text(encoding="utf-8").strip()
        if raw:
            yield Path(raw).expanduser().resolve()


def _is_keryx_root(path: Path) -> bool:
    return (
        (path / "bin" / "opsctl").is_file()
        and (path / "schemas" / "action-item.v1.schema.json").is_file()
        and (path / "skills" / "keryx" / "keryx-worker" / "SKILL.md").is_file()
    )


def _resolve_keryx_root() -> Path:
    for candidate in _candidate_roots():
        if _is_keryx_root(candidate):
            return candidate
    raise FileNotFoundError(
        "Could not resolve Keryx repository root from plugin path. "
        "Expected bin/opsctl, schemas/, and skills/keryx/."
    )


KERYX_ROOT = _resolve_keryx_root()


def _setup_argparse(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "opsctl_args",
        nargs=argparse.REMAINDER,
        help="Arguments passed to Keryx opsctl, e.g. doctor or list --status blocked",
    )
    parser.set_defaults(func=_handle_cli)


def _handle_cli(args: argparse.Namespace) -> None:
    argv = list(getattr(args, "opsctl_args", []) or [])
    if argv and argv[0] == "--":
        argv = argv[1:]

    env = os.environ.copy()
    env.setdefault("KERYX_CONFIG", str(KERYX_ROOT / "keryx.config.json"))
    completed = subprocess.run(
        [str(KERYX_ROOT / "bin" / "opsctl"), *argv],
        env=env,
        check=False,
    )
    raise SystemExit(completed.returncode)


def register(ctx) -> None:
    ctx.register_cli_command(
        name="keryx",
        help="Operate the Keryx action inbox",
        setup_fn=_setup_argparse,
        handler_fn=_handle_cli,
        description="Keryx CLI wrapper for schemas, card validation, Kanban actions, and doctor checks.",
    )

    for name, description in _SKILLS.items():
        ctx.register_skill(
            name,
            KERYX_ROOT / "skills" / "keryx" / name / "SKILL.md",
            description=description,
        )
