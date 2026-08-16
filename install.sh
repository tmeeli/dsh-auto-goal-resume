#!/usr/bin/env bash
# ============================================================
# dsh-auto-goal-resume 一键安装脚本
#
# 用法:
#   本地:   bash install.sh
#   远程:   bash <(curl -s https://gitee.com/okmyapp/dsh-auto-goal-resume/raw/master/install.sh)
#
# 作用:
#   1. 把插件包复制到 $DSH_HOME/plugins/auto-goal-resume
#   2. 注册为 web profile 的 bundle 插件(bundles + dependencies)
#   3. 创建 node_modules 符号链接
#   4. 清理早期版本遗留的手动 patch insert(若有)
#   5. 校验组合树
#   可重复执行(幂等)。
# ============================================================
set -euo pipefail

PKG_NAME="auto-goal-resume"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PLUGIN_DIR="$DSH_HOME/plugins/$PKG_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/5] 插件包位置"
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

echo "[2/5] 注册 bundle(dependencies + bundles)"
python3 - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" "$PKG_NAME" <<'PY'
import json, sys
path, plugin_dir, pkg = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)
bundles = data.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if pkg not in bundles:
    bundles.append(pkg)
deps = data.setdefault("dependencies", {})
deps[pkg] = f"link:{plugin_dir}"
with open(path, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"  bundles: {bundles}")
print(f"  dependencies: {pkg} -> {deps[pkg]}")
PY

echo "[3/5] 创建 node_modules 符号链接"
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/$PKG_NAME"
echo "  $PROFILE_DIR/node_modules/$PKG_NAME -> $PLUGIN_DIR"

echo "[4/5] 清理早期手动 patch insert(若有)"
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
    print("  已移除 cordis.patch.yml 中的手动 insert(改为 bundle 注册)")
else:
    print("  无需清理")
PY
else
  echo "  无 cordis.patch.yml"
fi

echo "[5/5] 校验组合树"
if command -v dsh >/dev/null 2>&1; then
  if dsh --profile web --dump-config 2>/dev/null | grep -q "$PKG_NAME"; then
    echo "  ✓ 组合树包含 $PKG_NAME"
  else
    echo "  ⚠ 未能确认组合树(可手动执行: dsh --profile web --dump-config | grep $PKG_NAME)"
  fi
else
  echo "  (未找到 dsh 命令,跳过校验;可稍后手动执行 dsh --profile web --dump-config 确认)"
fi

echo
echo "=============================================="
echo "✅ 安装完成!重启 DSH 生效:"
echo "   systemctl restart dsh-web.service"
echo "=============================================="
