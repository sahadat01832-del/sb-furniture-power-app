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
BUILT_TARGETS=""
CAP_CONFIG_SWITCHED_BY_SCRIPT=0
cd "$ROOT_DIR"

require_release_signing_credentials() {
    local variable_name
    for variable_name in ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_ALIAS ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD; do
        if [ -z "${!variable_name:-}" ]; then
            echo "❌ Set $variable_name in .env before building a release APK." >&2
            return 1
        fi
    done
    if [ ! -f "$ANDROID_KEYSTORE_PATH" ]; then
        echo "❌ The configured external Android release keystore was not found." >&2
        return 1
    fi
    case "$ANDROID_KEYSTORE_PATH" in
        /*) ;;
        *)
            echo "❌ ANDROID_KEYSTORE_PATH must be an absolute path outside the project." >&2
            return 1
            ;;
    esac
    case "$ANDROID_KEYSTORE_PATH" in
        "$ROOT_DIR"/*)
            echo "❌ Keep the Android release keystore outside the project directory." >&2
            return 1
            ;;
    esac
}

require_release_signing_credentials || exit 1

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
    sync_admin_file() {
        local source_file="$1"
        local target_file="$2"
        if [ -n "$(git status --porcelain -- "$target_file")" ]; then
            echo "ℹ️ Preserving local admin asset: $target_file"
            return 0
        fi
        mkdir -p "$(dirname "$target_file")"
        if [ "$target_file" = "public-admin/index.html" ]; then
            sed 's|href="/manifest-admin.json"|href="/manifest.json"|' "$source_file" > "$target_file"
        else
            cp "$source_file" "$target_file"
        fi
    }

    while IFS= read -r -d '' source_file; do
        target_file="public-admin/${source_file#public/}"
        sync_admin_file "$source_file" "$target_file"
    done < <(find public/css public/js public/icons -type f -print0)
    sync_admin_file public/admin.html public-admin/index.html
    if [ -f public/manifest-admin.json ]; then
        sync_admin_file public/manifest-admin.json public-admin/manifest.json
    fi
}

# Step 2: Ensure Capacitor CLI is available
ensure_capacitor() {
    if [ ! -x "node_modules/.bin/cap" ]; then
        echo "❌ Capacitor dependencies are missing. Run npm install before building APKs." >&2
        return 1
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
            if [ -e "android-$current" ]; then
                echo "❌ android-$current already exists. Move or review it before switching targets." >&2
                return 1
            fi
            mv android "android-$current"
        fi
    fi

    if [ ! -d "android" ] && [ -d "android-$target_type" ]; then
        echo "📂 Restoring previously configured $target_type Android project..."
        mv "android-$target_type" android
    fi
}

check_config_is_safe_to_switch() {
    if [ "$CAP_CONFIG_SWITCHED_BY_SCRIPT" -eq 1 ]; then
        return 0
    fi
    if ! git diff --quiet -- capacitor.config.json || ! git diff --cached --quiet -- capacitor.config.json; then
        echo "❌ capacitor.config.json has local changes. Review them before switching APK targets." >&2
        return 1
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

    check_config_is_safe_to_switch
    activate_target_dir "client"
    cp capacitor.client.json capacitor.config.json
    CAP_CONFIG_SWITCHED_BY_SCRIPT=1

    if [ -d "android" ] && [ ! -f "android/app/build.gradle" ]; then
        echo "❌ android/ exists but is incomplete. Review it before replacing or recreating it." >&2
        return 1
    fi
    if [ ! -d "android" ]; then
        echo "⚙️ Initializing Android platform for Client app..."
        npx cap add android
    fi
    echo "client" > android/.sb_target

    echo "🔄 Syncing Client web assets to Android project..."
    npx cap sync android
    patch_java_version

    if [ -f "android/gradlew" ] && { [ -n "$ANDROID_HOME" ] || [ -n "$ANDROID_SDK_ROOT" ]; }; then
        echo "🔨 Compiling Client Release APK..."
        (cd android && ./gradlew clean assembleRelease)
        if [ -f "android/app/build/outputs/apk/release/app-release.apk" ]; then
            cp android/app/build/outputs/apk/release/app-release.apk dist-apk/sb-power-reseller.apk
            BUILT_TARGETS="$BUILT_TARGETS client"
            echo "🎉 Client Release APK compiled: dist-apk/sb-power-reseller.apk"
        elif [ -f "android/app/build/outputs/apk/release/app-release-unsigned.apk" ]; then
            cp android/app/build/outputs/apk/release/app-release-unsigned.apk dist-apk/sb-power-reseller.apk
            BUILT_TARGETS="$BUILT_TARGETS client"
            echo "🎉 Client Release APK copied: dist-apk/sb-power-reseller.apk"
        else
            echo "❌ Gradle did not produce a release APK for the client app." >&2
            return 1
        fi
    else
        echo "ℹ️ Android SDK not configured in this terminal. Client Android project is generated & synced!"
        echo "   To build APK on a system with Android SDK:"
        echo "   cd android && ./gradlew assembleRelease"
        echo "   Output: android/app/build/outputs/apk/release/app-release.apk"
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

    check_config_is_safe_to_switch
    prepare_admin_web_assets
    activate_target_dir "admin"
    cp capacitor.admin.json capacitor.config.json
    CAP_CONFIG_SWITCHED_BY_SCRIPT=1

    if [ -d "android" ] && [ ! -f "android/app/build.gradle" ]; then
        echo "❌ android/ exists but is incomplete. Review it before replacing or recreating it." >&2
        return 1
    fi
    if [ ! -d "android" ]; then
        echo "⚙️ Initializing Android platform for Admin app..."
        npx cap add android
    fi
    echo "admin" > android/.sb_target

    echo "🔄 Syncing Admin web assets to Android project..."
    npx cap sync android
    patch_java_version

    if [ -f "android/gradlew" ] && { [ -n "$ANDROID_HOME" ] || [ -n "$ANDROID_SDK_ROOT" ]; }; then
        echo "🔨 Compiling Admin Release APK..."
        (cd android && ./gradlew clean assembleRelease)
        if [ -f "android/app/build/outputs/apk/release/app-release.apk" ]; then
            cp android/app/build/outputs/apk/release/app-release.apk dist-apk/sb-power-admin.apk
            BUILT_TARGETS="$BUILT_TARGETS admin"
            echo "🎉 Admin Release APK compiled: dist-apk/sb-power-admin.apk"
        elif [ -f "android/app/build/outputs/apk/release/app-release-unsigned.apk" ]; then
            cp android/app/build/outputs/apk/release/app-release-unsigned.apk dist-apk/sb-power-admin.apk
            BUILT_TARGETS="$BUILT_TARGETS admin"
            echo "🎉 Admin Release APK copied: dist-apk/sb-power-admin.apk"
        else
            echo "❌ Gradle did not produce a release APK for the admin app." >&2
            return 1
        fi
    else
        echo "ℹ️ Android SDK not configured in this terminal. Admin Android project is generated & synced!"
        echo "   To build APK on a system with Android SDK:"
        echo "   cd android && ./gradlew assembleRelease"
        echo "   Output: android/app/build/outputs/apk/release/app-release.apk"
    fi
}

ensure_capacitor

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
    echo "🎨 Generating custom brand icons..."
    if [ -n "$BUILT_TARGETS" ]; then
        python3 scripts/generate_app_icons.py $BUILT_TARGETS
    else
        python3 scripts/generate_app_icons.py
    fi
fi

echo ""
echo "=========================================================="
if [ -n "$BUILT_TARGETS" ]; then
    echo "🎉 APK Build & Signing Complete!"
else
    echo "✅ Android project configuration complete. No new APK was built because the Android SDK is unavailable."
fi
echo "Target: $TARGET"
echo "Client Project: com.sbfurniture.powerapp (webDir: public)"
echo "Admin Project:  com.sbfurniture.admin   (webDir: public-admin)"
echo "=========================================================="
