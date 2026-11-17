#!/bin/bash
# ARM64 友好的最小 APK 构建链（树莓派上可直接跑）：
#   Debian aapt（arm64 原生）→ javac → d8（bash 脚本，与架构无关）→ aapt add → apksigner
# 不用 Gradle，也不用 x86_64 的 aapt2/zipalign（那俩在 ARM 上跑不了）。
set -euo pipefail

SDK="$HOME/android-sdk"
PLATFORM="$SDK/platforms/android-34/android.jar"
D8="$SDK/build-tools/34.0.0/d8"
APP="$HOME/android-hid/bridge_app"
OUT="$APP/build"
MIN_SDK=29
TGT_SDK=34

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

echo "== 1/5 aapt package（清单+资源 → 基础 APK）=="
aapt package -f -M "$APP/AndroidManifest.xml" -S "$APP/res" -I "$PLATFORM" -F "$OUT/base.apk" \
  --min-sdk-version $MIN_SDK --target-sdk-version $TGT_SDK

echo "== 2/5 javac =="
find "$APP/src" -name '*.java' > "$OUT/sources.txt"
javac -nowarn -parameters -encoding UTF-8 -source 8 -target 8 \
  -classpath "$PLATFORM" -d "$OUT/classes" @"$OUT/sources.txt"

echo "== 3/5 d8（class → dex）=="
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$D8" --lib "$PLATFORM" --min-api $MIN_SDK --output "$OUT/dex" @"$OUT/classes.txt"

echo "== 4/5 把 classes.dex 打进 APK =="
( cd "$OUT/dex" && aapt add "$OUT/base.apk" classes.dex )

echo "== 5/5 签名 =="
KS="$HOME/.android/tangyuan.keystore"
if [ ! -f "$KS" ]; then
  mkdir -p "$HOME/.android"
  keytool -genkeypair -v -keystore "$KS" -alias tangyuan \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass tangyuan -keypass tangyuan \
    -dname "CN=Tangyuan Bridge, O=Tangyuan, C=CN" >/dev/null 2>&1
  echo "  已生成签名证书 $KS"
fi
apksigner sign --ks "$KS" --ks-pass pass:tangyuan --key-pass pass:tangyuan \
  --out "$APP/TangyuanBridge.apk" "$OUT/base.apk"
apksigner verify --print-certs "$APP/TangyuanBridge.apk" | head -4
echo
ls -lh "$APP/TangyuanBridge.apk"
