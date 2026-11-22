#!/usr/bin/env bash
# ============================================================
# SB Furniture & SB POWER — Dual Android APK Generator
# Builds 2 Separate, Conflict-Free APKs:
#   1. Client & Reseller App (com.sbfurniture.powerapp) -> public/index.html
#   2. Dedicated Admin App   (com.sbfurniture.admin)   -> public-admin/index.html
# ============================================================

set -e

TARGET="${1:-all}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=========================================================="
echo "📱 SB Furniture & SB POWER — Dual APK Build System"
echo "Target: $TARGET (Options: client | admin | all)"
echo "=========================================================="

mkdir -p dist-apk

# Check for node and npm
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed. Please install Node.js."
    exit 1
fi

# Always use Temurin JDK 17 for compilation
if [ -d "/home/don/.local/share/jvm/temurin-17" ]; then
    export JAVA_HOME="/home/don/.local/share/jvm/temurin-17"
    export PATH="$JAVA_HOME/bin:$PATH"
    echo "☕ Using JDK 17 at: $JAVA_HOME"
fi

# Auto-detect ANDROID_HOME if not set
if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
    if [ -d "/home/don/whynet ecosystem/NEWTUBE/NewTube_Android/.android-sdk" ]; then
        export ANDROID_HOME="/home/don/whynet ecosystem/NEWTUBE/NewTube_Android/.android-sdk"
        export ANDROID_SDK_ROOT="$ANDROID_HOME"
        export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
        echo "🤖 Detected Android SDK at: $ANDROID_HOME"
    elif [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
        export ANDROID_SDK_ROOT="$ANDROID_HOME"
    fi
fi

# Step 1: Sync and prepare public-admin assets
prepare_admin_web_assets() {
    echo "1. Preparing web assets for Admin APK (public-admin/)..."
    mkdir -p public-admin/css public-admin/js public-admin/icons
    cp -r public/css/* public-admin/css/ 2>/dev/null || true
    cp -r public/js/* public-admin/js/ 2>/dev/null || true
    cp -r public/icons/* public-admin/icons/ 2>/dev/null || true
    cp public/admin.html public-admin/index.html
    cp public/manifest-admin.json public-admin/manifest.json 2>/dev/null || true
}

# Step 2: Ensure Capacitor CLI is available
ensure_capacitor() {
    if ! npx cap --version &> /dev/null; then
        echo "📦 Installing @capacitor/core, @capacitor/cli, @capacitor/android..."
        npm install --save @capacitor/core
        npm install --save-dev @capacitor/cli @capacitor/android
    fi
}

# Switch Android project directory to prevent target collisions
activate_target_dir() {
    local target_type="$1" # client or admin

    if [ -d "android" ]; then
        local current=""
        if [ -f "android/.sb_target" ]; then
            current=$(cat android/.sb_target)
        elif grep -q "com.sbfurniture.admin" android/app/build.gradle 2>/dev/null; then
            current="admin"
        elif grep -q "com.sbfurniture.powerapp" android/app/build.gradle 2>/dev/null; then
            current="client"
        fi

        if [ -n "$current" ] && [ "$current" != "$target_type" ]; then
            echo "📦 Stashing active $current Android project to android-$current..."
            rm -rf "android-$current"
            mv android "android-$current"
        fi
    fi

    if [ ! -d "android" ] && [ -d "android-$target_type" ]; then
        echo "📂 Restoring previously configured $target_type Android project..."
        mv "android-$target_type" android
    fi
}

# Ensure Java 17 compileOptions across gradle files
patch_java_version() {
    if [ -f "android/app/build.gradle" ]; then
        if ! grep -q "JavaVersion.VERSION_17" android/app/build.gradle; then
            sed -i 's/JavaVersion.VERSION_21/JavaVersion.VERSION_17/g' android/app/build.gradle
        fi
        if ! grep -q "compileOptions" android/app/build.gradle; then
            sed -i '/buildTypes {/i \    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }' android/app/build.gradle
        fi
    fi
    if [ -f "android/app/capacitor.build.gradle" ]; then
        sed -i 's/JavaVersion.VERSION_21/JavaVersion.VERSION_17/g' android/app/capacitor.build.gradle
    fi
    if [ -f "android/capacitor-cordova-android-plugins/build.gradle" ]; then
        sed -i 's/JavaVersion.VERSION_21/JavaVersion.VERSION_17/g' android/capacitor-cordova-android-plugins/build.gradle
    fi
    if [ -f "node_modules/@capacitor/android/capacitor/build.gradle" ]; then
        sed -i 's/JavaVersion.VERSION_21/JavaVersion.VERSION_17/g' node_modules/@capacitor/android/capacitor/build.gradle
    fi
}

# Function to build Client App
build_client() {
    echo ""
    echo "=========================================================="
    echo "🚀 Configuring APK 1: Client & Reseller App"
    echo "   App ID:   com.sbfurniture.powerapp"
    echo "   App Name: SB Furniture & SB POWER"
    echo "   Web Dir:  public (entry: index.html)"
    echo "=========================================================="

    activate_target_dir "client"
    cp capacitor.client.json capacitor.config.json

    if [ ! -d "android" ] || [ ! -f "android/app/build.gradle" ]; then
        echo "⚙️ Initializing Android platform for Client app..."
        rm -rf android
        npx cap add android
    fi
    echo "client" > android/.sb_target

    echo "🔄 Syncing Client web assets to Android project..."
    npx cap sync android
    patch_java_version

    if [ -f "android/gradlew" ] && { [ -n "$ANDROID_HOME" ] || [ -n "$ANDROID_SDK_ROOT" ]; }; then
        echo "🔨 Compiling Client APK..."
        (cd android && ./gradlew clean assembleDebug)
        if [ -f "android/app/build/outputs/apk/debug/app-debug.apk" ]; then
            cp android/app/build/outputs/apk/debug/app-debug.apk dist-apk/sb-power-reseller.apk
            echo "🎉 Client APK compiled: dist-apk/sb-power-reseller.apk"
        fi
    else
        echo "ℹ️ Android SDK not configured in this terminal. Client Android project is generated & synced!"
        echo "   To build APK on a system with Android SDK:"
        echo "   cd android && ./gradlew assembleDebug"
        echo "   Output: android/app/build/outputs/apk/debug/app-debug.apk"
    fi
}

# Function to build Admin App
build_admin() {
    echo ""
    echo "=========================================================="
    echo "🚀 Configuring APK 2: Dedicated Admin Control App"
    echo "   App ID:   com.sbfurniture.admin"
    echo "   App Name: SB Furniture Admin Panel"
    echo "   Web Dir:  public-admin (entry: index.html -> admin.html)"
    echo "=========================================================="

    prepare_admin_web_assets
    activate_target_dir "admin"
    cp capacitor.admin.json capacitor.config.json

    if [ ! -d "android" ] || [ ! -f "android/app/build.gradle" ]; then
        echo "⚙️ Initializing Android platform for Admin app..."
        rm -rf android
        npx cap add android
    fi
    echo "admin" > android/.sb_target

    echo "🔄 Syncing Admin web assets to Android project..."
    npx cap sync android
    patch_java_version

    if [ -f "android/gradlew" ] && { [ -n "$ANDROID_HOME" ] || [ -n "$ANDROID_SDK_ROOT" ]; }; then
        echo "🔨 Compiling Admin APK..."
        (cd android && ./gradlew clean assembleDebug)
        if [ -f "android/app/build/outputs/apk/debug/app-debug.apk" ]; then
            cp android/app/build/outputs/apk/debug/app-debug.apk dist-apk/sb-power-admin.apk
            echo "🎉 Admin APK compiled: dist-apk/sb-power-admin.apk"
        fi
    else
        echo "ℹ️ Android SDK not configured in this terminal. Admin Android project is generated & synced!"
        echo "   To build APK on a system with Android SDK:"
        echo "   cd android && ./gradlew assembleDebug"
        echo "   Output: android/app/build/outputs/apk/debug/app-debug.apk"
    fi
}

ensure_capacitor
prepare_admin_web_assets

case "$TARGET" in
    client)
        build_client
        ;;
    admin)
        build_admin
        ;;
    all)
        build_client
        build_admin
        ;;
    *)
        echo "❌ Unknown target '$TARGET'. Use 'client', 'admin', or 'all'."
        exit 1
        ;;
esac

if [ -f "scripts/generate_app_icons.py" ]; then
    echo "🎨 Injecting custom brand icons and signing APKs..."
    python3 scripts/generate_app_icons.py || true
fi

echo ""
echo "=========================================================="
echo "🎉 APK Build & Configuration Complete!"
echo "Target: $TARGET"
echo "Client Project: com.sbfurniture.powerapp (webDir: public)"
echo "Admin Project:  com.sbfurniture.admin   (webDir: public-admin)"
echo "=========================================================="
