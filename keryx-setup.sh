#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$SCRIPT_DIR
CONFIG_PATH=${KERYX_CONFIG:-"$ROOT_DIR/keryx.config.json"}
HERMES_BIN=${HERMES_BIN:-hermes}
DRY_RUN=0
FORCE=0
HERMES_HOME_ARG=""

usage() {
  cat <<'USAGE'
Usage: ./keryx-setup.sh [options]

Options:
  --dry-run                    Print intended actions without writing files or running Hermes commands
  --hermes-home <path>         Install/enable the Keryx plugin in this Hermes home
  --force                      Replace an existing conflicting Keryx plugin path and overwrite an existing keryx.config.json
  --help                       Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --hermes-home)
      shift
      if [ "$#" -eq 0 ]; then
        echo "FAIL --hermes-home requires a path" >&2
        exit 2
      fi
      HERMES_HOME_ARG=$1
      ;;
    --force)
      FORCE=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "FAIL unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

resolve_home() {
  if [ -n "$HERMES_HOME_ARG" ]; then
    printf '%s\n' "$HERMES_HOME_ARG"
  elif [ -n "${HERMES_HOME:-}" ]; then
    printf '%s\n' "$HERMES_HOME"
  else
    printf '%s\n' "$HOME/.hermes"
  fi
}

expand_tilde() {
  case "$1" in
    '~') printf '%s\n' "$HOME" ;;
    '~/'*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

HERMES_HOME_PATH=$(expand_tilde "$(resolve_home)")
PLUGIN_SOURCE_DIR="$ROOT_DIR/hermes-plugin"
PLUGIN_TARGET_DIR="$HERMES_HOME_PATH/plugins/keryx"
case "$CONFIG_PATH" in
  /*) ;;
  *) CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH" ;;
esac

say() {
  printf '%s\n' "$*"
}

require_hermes_cli() {
  if command -v "$HERMES_BIN" >/dev/null 2>&1; then
    say "OK hermes CLI found: $(command -v "$HERMES_BIN")"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would require Hermes CLI on PATH: $HERMES_BIN"
    return 0
  fi

  echo "FAIL Hermes CLI not found or not executable: $HERMES_BIN" >&2
  exit 1
}

run_hermes() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would run: $HERMES_BIN $*"
    return 0
  fi

  HERMES_HOME="$HERMES_HOME_PATH" "$HERMES_BIN" "$@"
}

create_board() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would create Kanban board keryx"
    return 0
  fi

  err_file=$(mktemp)
  if HERMES_HOME="$HERMES_HOME_PATH" "$HERMES_BIN" kanban boards create keryx --name Keryx > /dev/null 2>"$err_file"; then
    rm -f "$err_file"
    say "OK board keryx ensured"
    return 0
  fi

  if grep -qi 'exist\|already' "$err_file"; then
    rm -f "$err_file"
    say "OK board keryx already exists"
    return 0
  fi

  cat "$err_file" >&2
  rm -f "$err_file"
  exit 1
}

assert_plugin_target_safe() {
  if [ -z "$PLUGIN_TARGET_DIR" ] || [ "$PLUGIN_TARGET_DIR" != "$HERMES_HOME_PATH/plugins/keryx" ]; then
    echo "FAIL unsafe Keryx plugin target path: $PLUGIN_TARGET_DIR" >&2
    exit 1
  fi
}

copy_plugin_adapter() {
  mkdir -p "$PLUGIN_TARGET_DIR"
  cp "$PLUGIN_SOURCE_DIR/plugin.yaml" "$PLUGIN_TARGET_DIR/plugin.yaml"
  cp "$PLUGIN_SOURCE_DIR/__init__.py" "$PLUGIN_TARGET_DIR/__init__.py"
  printf '%s\n' "$ROOT_DIR" > "$PLUGIN_TARGET_DIR/keryx-root.txt"
  say "OK copied plugin adapter: $PLUGIN_TARGET_DIR"
}

install_plugin() {
  if [ ! -f "$PLUGIN_SOURCE_DIR/plugin.yaml" ] || [ ! -f "$PLUGIN_SOURCE_DIR/__init__.py" ]; then
    echo "FAIL Hermes plugin adapter missing under $PLUGIN_SOURCE_DIR" >&2
    exit 1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would install Keryx Hermes plugin at $PLUGIN_TARGET_DIR from $PLUGIN_SOURCE_DIR"
    return 0
  fi

  mkdir -p "$(dirname -- "$PLUGIN_TARGET_DIR")"

  if [ -L "$PLUGIN_TARGET_DIR" ]; then
    current=$(readlink "$PLUGIN_TARGET_DIR" || true)
    if [ "$current" = "$PLUGIN_SOURCE_DIR" ]; then
      say "OK plugin symlink already installed: $PLUGIN_TARGET_DIR -> $PLUGIN_SOURCE_DIR"
      return 0
    fi
    if [ "$FORCE" -ne 1 ]; then
      echo "FAIL existing Keryx plugin symlink points elsewhere: $PLUGIN_TARGET_DIR -> $current" >&2
      exit 1
    fi
    assert_plugin_target_safe
    rm -f "$PLUGIN_TARGET_DIR"
  elif [ -e "$PLUGIN_TARGET_DIR" ]; then
    if [ "$FORCE" -ne 1 ]; then
      echo "FAIL existing Keryx plugin path exists; rerun with --force to replace: $PLUGIN_TARGET_DIR" >&2
      exit 1
    fi
    assert_plugin_target_safe
    rm -rf "$PLUGIN_TARGET_DIR"
  fi

  if [ "${KERYX_SETUP_DISABLE_SYMLINK:-0}" != "1" ] && ln -s "$PLUGIN_SOURCE_DIR" "$PLUGIN_TARGET_DIR" 2>/dev/null; then
    say "OK installed plugin symlink: $PLUGIN_TARGET_DIR -> $PLUGIN_SOURCE_DIR"
    return 0
  fi

  copy_plugin_adapter
}

enable_plugin() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would enable Hermes plugin keryx with: $HERMES_BIN plugins enable keryx"
    return 0
  fi
  run_hermes plugins enable keryx
  say "OK plugin keryx enabled"
}

write_config() {
  config_exists=0
  if [ -e "$CONFIG_PATH" ]; then
    config_exists=1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$config_exists" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
      say "DRY-RUN would keep existing Keryx config: $CONFIG_PATH"
    elif [ "$config_exists" -eq 1 ]; then
      say "DRY-RUN would overwrite existing Keryx config: $CONFIG_PATH"
    else
      say "DRY-RUN would write Keryx config to $CONFIG_PATH"
    fi
    return 0
  fi

  if [ "$config_exists" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
    if [ -t 0 ]; then
      printf '%s' "keryx.config.json exists; overwrite? [y/N] "
      read -r reply || reply=""
      case "$reply" in
        [Yy]|[Yy][Ee][Ss]) ;;
        *)
          say "OK keeping existing config"
          return 0
          ;;
      esac
    else
      say "WARN existing keryx.config.json kept; rerun with --force to overwrite"
      return 0
    fi
  fi

  mkdir -p "$(dirname -- "$CONFIG_PATH")"
  node --input-type=module - "$CONFIG_PATH" "$HERMES_BIN" <<'NODE'
import { writeFileSync } from 'node:fs';

const [configPath, hermesBin] = process.argv.slice(2);
const config = {
  board: 'keryx',
  defaultAssignee: 'default',
  hermesBin,
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE
  say "OK wrote Keryx config: $CONFIG_PATH"
}

run_doctor() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would run hermes keryx doctor"
    return 0
  fi

  HERMES_HOME="$HERMES_HOME_PATH" KERYX_CONFIG="$CONFIG_PATH" "$HERMES_BIN" keryx doctor
}

require_hermes_cli
create_board
install_plugin
enable_plugin
write_config
run_doctor
say "OK setup complete"
