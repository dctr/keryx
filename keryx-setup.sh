#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$SCRIPT_DIR
SOURCE_SKILLS_DIR="$ROOT_DIR/skills/keryx"
CONFIG_PATH=${KERYX_CONFIG:-"$ROOT_DIR/keryx.config.json"}
HERMES_BIN=${HERMES_BIN:-hermes}
DRY_RUN=0
FORCE=0
LOCAL_ONLY=0
DELIVERY_TARGET=""
HERMES_HOME_ARG=""

usage() {
  cat <<'USAGE'
Usage: ./keryx-setup.sh [options]

Options:
  --dry-run                    Print intended actions without writing files or running Hermes commands
  --hermes-home <path>         Install bundled Keryx skills into this Hermes home
  --force                      Overwrite existing installed Keryx skill files
  --delivery-target <target>   Configure the default Keryx delivery target
  --local-only                 Configure Keryx without a default delivery target
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
    --delivery-target)
      shift
      if [ "$#" -eq 0 ]; then
        echo "FAIL --delivery-target requires a target" >&2
        exit 2
      fi
      DELIVERY_TARGET=$1
      ;;
    --local-only)
      LOCAL_ONLY=1
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

install_skills() {
  if [ ! -d "$SOURCE_SKILLS_DIR" ]; then
    echo "FAIL bundled skills directory missing: $SOURCE_SKILLS_DIR" >&2
    exit 1
  fi

  target_dir="$HERMES_HOME_PATH/skills/keryx"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would install bundled Keryx skills into $target_dir"
    return 0
  fi

  find "$SOURCE_SKILLS_DIR" -type d | while IFS= read -r source_dir; do
    relative=${source_dir#"$SOURCE_SKILLS_DIR"}
    mkdir -p "$target_dir$relative"
  done

  find "$SOURCE_SKILLS_DIR" -type f | while IFS= read -r source_file; do
    relative=${source_file#"$SOURCE_SKILLS_DIR"/}
    target_file="$target_dir/$relative"
    if [ -e "$target_file" ] && [ "$FORCE" -ne 1 ]; then
      say "SKIP preserved existing skill file: $target_file"
      continue
    fi
    mkdir -p "$(dirname -- "$target_file")"
    cp "$source_file" "$target_file"
    say "OK installed skill file: $target_file"
  done
}

discover_delivery_targets() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would discover delivery targets with: $HERMES_BIN send --list --json"
    if [ -z "$DELIVERY_TARGET" ] && [ "$LOCAL_ONLY" -eq 0 ]; then
      LOCAL_ONLY=1
    fi
    return 0
  fi

  if ! DELIVERY_TARGETS_JSON=$(HERMES_HOME="$HERMES_HOME_PATH" "$HERMES_BIN" send --list --json 2>/dev/null); then
    DELIVERY_TARGETS_JSON='[]'
    say "WARN could not list Hermes delivery targets; continuing with explicit/local-only configuration"
  fi

  if [ -z "$DELIVERY_TARGET" ] && [ "$LOCAL_ONLY" -eq 0 ]; then
    if [ -t 0 ]; then
      say "Available Hermes delivery targets:"
      printf '%s\n' "$DELIVERY_TARGETS_JSON"
      printf 'Default Keryx delivery target (blank for local-only): '
      IFS= read -r DELIVERY_TARGET || DELIVERY_TARGET=""
      if [ -z "$DELIVERY_TARGET" ]; then
        LOCAL_ONLY=1
      fi
    else
      LOCAL_ONLY=1
      say "WARN no --delivery-target supplied in non-interactive mode; using local-only configuration"
    fi
  fi

  if [ "$LOCAL_ONLY" -eq 1 ]; then
    DELIVERY_TARGET=""
  fi
}

write_config() {
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$LOCAL_ONLY" -eq 1 ]; then
      say "DRY-RUN would write Keryx config to $CONFIG_PATH with localOnly=true"
    else
      say "DRY-RUN would write Keryx config to $CONFIG_PATH with defaultDeliveryTarget=${DELIVERY_TARGET:-null}"
    fi
    return 0
  fi

  mkdir -p "$(dirname -- "$CONFIG_PATH")"
  node --input-type=module - "$CONFIG_PATH" "$DELIVERY_TARGET" "$LOCAL_ONLY" "$HERMES_BIN" <<'NODE'
import { writeFileSync } from 'node:fs';

const [configPath, deliveryTarget, localOnly, hermesBin] = process.argv.slice(2);
const config = {
  board: 'keryx',
  pollIntervalMs: 30000,
  defaultAssignee: 'default',
  defaultDeliveryTarget: deliveryTarget || null,
  localOnly: localOnly === '1',
  hermesBin,
  host: '127.0.0.1',
  port: 4173,
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE
  say "OK wrote Keryx config: $CONFIG_PATH"
}

run_doctor() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would run ./bin/opsctl doctor"
    return 0
  fi

  HERMES_HOME="$HERMES_HOME_PATH" KERYX_CONFIG="$CONFIG_PATH" "$ROOT_DIR/bin/opsctl" doctor
}

require_hermes_cli
create_board
install_skills
discover_delivery_targets
write_config
run_doctor
say "OK setup complete"
