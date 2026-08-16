#!/usr/bin/env bash
# ============================================================
# dsh-auto-goal-resume 一键安装脚本
#
# 用法:
#   npm 模式(默认,推荐):
#     bash install.sh
#     bash <(curl -s https://gitee.com/okmyapp/dsh-auto-goal-resume/raw/master/install.sh)
#     # → pnpm add auto-goal-resume + 自动注册 bundle
#
#   本地开发模式(改代码即时生效):
#     bash install.sh --local
#     # → 复制本地插件目录 + link 引用 + 注册 bundle
#
# 作用:安装依赖、注册为 web profile 的 bundle、清理旧配置、校验组合树。
# 可重复执行(幂等)。
# ============================================================
set -euo pipefail

PKG_NAME="auto-goal-resume"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PLUGIN_DIR="$DSH_HOME/plugins/$PKG_NAME"
MODE="${1:-npm}"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误:找不到 web profile 目录 $PROFILE_DIR(请先初始化 web profile)" >&2
  exit 1
fi

register_bundle() {
  echo "[bundle] 注册到 dsh.profile.bundles + dependencies"
  python3 - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" "$PKG_NAME" "$MODE" <<'PY'
import json, sys
path, plugin_dir, pkg, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(path) as f:
    data = json.load(f)
bundles = data.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if pkg not in bundles:
    bundles.append(pkg)
deps = data.setdefault("dependencies", {})
if mode == "local":
    deps[pkg] = f"link:{plugin_dir}"
elif pkg not in deps:
    deps[pkg] = "^1.0.0"
with open(path, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"  bundles: {bundles}")
print(f"  dependencies: {deps[pkg]}")
PY
}

clean_legacy_patch() {
  echo "[patch] 清理早期手动 insert(若有)"
  PATCH="$PROFILE_DIR/cordis.patch.yml"
  if [ -f "$PATCH" ]; then
    python3 - "$PATCH" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
pattern = re.compile(
    r"# ── 自动恢复活跃目标\(auto-goal-resume\)──.*?- insert:\n\s+- id: auto-goal-resume\n\s+name: auto-goal-resume\n?",
    re.S,
)
new = pattern.sub("", text)
if new != text:
    with open(path, "w") as f:
        f.write(new)
    print("  已移除 cordis.patch.yml 中的手动 insert")
else:
    print("  无需清理")
PY
  else
    echo "  无 cordis.patch.yml"
  fi
}

verify_tree() {
  echo "[verify] 校验组合树"
  if command -v dsh >/dev/null 2>&1; then
    if dsh --profile web --dump-config 2>/dev/null | grep -q "$PKG_NAME"; then
      echo "  ✓ 组合树包含 $PKG_NAME"
    else
      echo "  ⚠ 未能确认组合树(可手动执行: dsh --profile web --dump-config | grep $PKG_NAME)"
    fi
  else
    echo "  (未找到 dsh 命令,跳过校验)"
  fi
}

if [ "$MODE" = "--local" ] || [ "$MODE" = "local" ]; then
  echo "==== 本地开发模式 ===="
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "[1/4] 插件包位置"
  if [ "$SCRIPT_DIR" != "$PLUGIN_DIR" ]; then
    echo "  复制 $SCRIPT_DIR → $PLUGIN_DIR"
    mkdir -p "$(dirname "$PLUGIN_DIR")"
    rm -rf "$PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
    cp -r "$SCRIPT_DIR/." "$PLUGIN_DIR/"
    rm -rf "$PLUGIN_DIR/.git"
  else
    echo "  已在 $PLUGIN_DIR,跳过复制"
  fi
  echo "[2/4] 符号链接"
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/$PKG_NAME"
  echo "  $PROFILE_DIR/node_modules/$PKG_NAME -> $PLUGIN_DIR"
  register_bundle
  clean_legacy_patch
  verify_tree
else
  echo "==== npm 模式 ===="
  echo "[1/4] 安装依赖: pnpm add $PKG_NAME"
  (cd "$PROFILE_DIR" && pnpm add "$PKG_NAME")
  register_bundle
  clean_legacy_patch
  verify_tree
fi

echo
echo "=============================================="
echo "✅ 安装完成!重启 DSH 生效:"
echo "   systemctl restart dsh-web.service"
echo "=============================================="
