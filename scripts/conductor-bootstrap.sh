#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
SOURCE_ROOT="${INNIES_CONDUCTOR_SOURCE_ROOT:-${HOME}/innies}"

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "missing required command: ${command_name}"
}

ensure_source_root() {
  [[ -d "$SOURCE_ROOT" ]] || die "missing canonical innies checkout: ${SOURCE_ROOT}"
  SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd -P)"
}

link_required_env() {
  local relative_path="$1"
  local source_path="${SOURCE_ROOT}/${relative_path}"
  local dest_path="${ROOT_DIR}/${relative_path}"

  [[ -s "$source_path" ]] || die "missing required source env file: ${source_path}"
  mkdir -p "$(dirname "$dest_path")"

  if [[ -e "$dest_path" && ! -L "$dest_path" ]]; then
    die "refusing to replace existing non-symlink file: ${dest_path}"
  fi

  ln -sfn "$source_path" "$dest_path"
  echo "linked ${relative_path}"
}

install_if_needed() {
  local relative_dir="$1"
  local dir_path="${ROOT_DIR}/${relative_dir}"

  [[ -d "$dir_path" ]] || return 0
  [[ -f "${dir_path}/package.json" ]] || return 0

  if [[ -d "${dir_path}/node_modules" ]]; then
    echo "dependencies already present in ${relative_dir}; skipping install"
    return 0
  fi

  if [[ -f "${dir_path}/package-lock.json" ]]; then
    require_command npm
    echo "installing ${relative_dir} dependencies with npm"
    (
      cd "$dir_path"
      npm install
    )
    return 0
  fi

  if [[ -f "${dir_path}/pnpm-lock.yaml" ]]; then
    require_command pnpm
    echo "installing ${relative_dir} dependencies with pnpm"
    (
      cd "$dir_path"
      pnpm install
    )
    return 0
  fi

  echo "no lockfile for ${relative_dir}; skipping install"
}

main() {
  ensure_source_root

  if [[ "$ROOT_DIR" == "$SOURCE_ROOT" ]]; then
    echo "running in canonical checkout; skipping Conductor bootstrap"
    return 0
  fi

  link_required_env "api/.env"
  link_required_env "scripts/.env.local"
  link_required_env "ui/.env.local"

  install_if_needed "api"
  install_if_needed "ui"
}

main "$@"
