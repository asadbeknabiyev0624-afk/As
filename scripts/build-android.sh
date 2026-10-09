#!/usr/bin/env bash
# Build the native Android client without Gradle or third-party Java libraries.
# Requires Bash, curl, unzip, zip, tar and checksum utilities (Linux/macOS).
# SDK/JDK caches and the private DEVELOPMENT signing key stay outside the repo.
set -euo pipefail
umask 077

JARVIS_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
JARVIS_ANDROID_TOOLS="${JARVIS_ANDROID_TOOLS:-$(dirname "$JARVIS_REPO")/.jarvis-android-tools}"
JARVIS_ANDROID_OUTPUT="${JARVIS_ANDROID_OUTPUT:-$(dirname "$JARVIS_REPO")/scratch/JARVIS-Android.apk}"
JARVIS_DOWNLOADS="$JARVIS_ANDROID_TOOLS/downloads"
JARVIS_BUILD="$JARVIS_ANDROID_TOOLS/build"
mkdir -p "$JARVIS_DOWNLOADS" "$JARVIS_BUILD" "$(dirname "$JARVIS_ANDROID_OUTPUT")"

fetch_verified() {
    local url="$1" archive="$2" algorithm="$3" expected="$4" actual
    if [[ ! -f "$archive" ]]; then
        curl --fail --location --silent --show-error --retry 2 --max-time 300 "$url" -o "$archive.part"
        mv "$archive.part" "$archive"
    fi
    actual="$("${algorithm}sum" "$archive" | cut -d ' ' -f 1)"
    if [[ "$actual" != "$expected" ]]; then
        printf 'Checksum verification failed for %s; refusing to use this artifact.\n' "$(basename "$archive")" >&2
        exit 1
    fi
}

fetch_verified 'https://dl.google.com/android/repository/platform-35_r02.zip' "$JARVIS_DOWNLOADS/platform-35_r02.zip" sha1 0bb560a90a7a2cbd0dd8348224d518b638fe7949
fetch_verified 'https://dl.google.com/android/repository/build-tools_r35_linux.zip' "$JARVIS_DOWNLOADS/build-tools_r35_linux.zip" sha1 2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc
if [[ ! -f "$JARVIS_ANDROID_TOOLS/sdk-platform/android-35/android.jar" ]]; then
    unzip -q "$JARVIS_DOWNLOADS/platform-35_r02.zip" -d "$JARVIS_ANDROID_TOOLS/sdk-platform"
fi
if [[ ! -f "$JARVIS_ANDROID_TOOLS/sdk-build/android-15/aapt2" ]]; then
    unzip -q "$JARVIS_DOWNLOADS/build-tools_r35_linux.zip" -d "$JARVIS_ANDROID_TOOLS/sdk-build"
fi

# Use an existing developer JDK when supplied; otherwise provision the verified
# Oracle JDK 21 build used here. Java is a build tool, never bundled in the APK.
if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/javac" ]]; then
    JARVIS_JDK="$JAVA_HOME"
else
    fetch_verified 'https://download.oracle.com/java/21/archive/jdk-21.0.12.1_linux-x64_bin.tar.gz' "$JARVIS_DOWNLOADS/jdk-21.tar.gz" sha256 12f870b21301b42292558a3f872ce543affa2b86cb6458591c78388c41ddb111
    JARVIS_JDK="$JARVIS_ANDROID_TOOLS/jdk"
    if [[ ! -x "$JARVIS_JDK/bin/javac" ]]; then
        mkdir -p "$JARVIS_JDK"
        tar -xzf "$JARVIS_DOWNLOADS/jdk-21.tar.gz" --strip-components=1 -C "$JARVIS_JDK"
    fi
fi
export JAVA_HOME="$JARVIS_JDK"
export PATH="$JARVIS_JDK/bin:$PATH"

JARVIS_SDK_BUILD="$JARVIS_ANDROID_TOOLS/sdk-build/android-15"
JARVIS_ANDROID_JAR="$JARVIS_ANDROID_TOOLS/sdk-platform/android-35/android.jar"
JARVIS_APP="$JARVIS_REPO/platforms/android/app/src/main"
rm -rf "$JARVIS_BUILD/classes" "$JARVIS_BUILD/dex" "$JARVIS_BUILD/generated"
mkdir -p "$JARVIS_BUILD/classes" "$JARVIS_BUILD/dex" "$JARVIS_BUILD/generated"
"$JARVIS_SDK_BUILD/aapt2" compile --dir "$JARVIS_APP/res" -o "$JARVIS_BUILD/resources.zip"
"$JARVIS_SDK_BUILD/aapt2" link -o "$JARVIS_BUILD/unsigned.apk" -I "$JARVIS_ANDROID_JAR" \
    --manifest "$JARVIS_APP/AndroidManifest.xml" --java "$JARVIS_BUILD/generated" "$JARVIS_BUILD/resources.zip"
find "$JARVIS_APP/java" "$JARVIS_BUILD/generated" -name '*.java' > "$JARVIS_BUILD/sources.txt"
"$JARVIS_JDK/bin/javac" -encoding UTF-8 -source 8 -target 8 -Xlint:-options \
    -bootclasspath "$JARVIS_ANDROID_JAR:$JARVIS_SDK_BUILD/core-lambda-stubs.jar" -d "$JARVIS_BUILD/classes" @"$JARVIS_BUILD/sources.txt"
"$JARVIS_JDK/bin/jar" --create --file "$JARVIS_BUILD/classes.jar" -C "$JARVIS_BUILD/classes" .
"$JARVIS_SDK_BUILD/d8" --min-api 26 --lib "$JARVIS_ANDROID_JAR" --output "$JARVIS_BUILD/dex" "$JARVIS_BUILD/classes.jar"
(cd "$JARVIS_BUILD/dex" && zip -q -j "$JARVIS_BUILD/unsigned.apk" classes.dex)
"$JARVIS_SDK_BUILD/zipalign" -f -p 4 "$JARVIS_BUILD/unsigned.apk" "$JARVIS_BUILD/aligned.apk"

JARVIS_SIGNING="$JARVIS_ANDROID_TOOLS/development-signing"
mkdir -p "$JARVIS_SIGNING"
if [[ ! -f "$JARVIS_SIGNING/keystore.p12" ]]; then
    if [[ ! -f "$JARVIS_SIGNING/password" ]]; then
        od -An -N 36 -tx1 /dev/urandom | tr -d ' \n' > "$JARVIS_SIGNING/password"
    fi
    # Password is never passed on the command line or copied to artifacts.
    JARVIS_ANDROID_SIGNING_PASSWORD="$(cat "$JARVIS_SIGNING/password")"
    export JARVIS_ANDROID_SIGNING_PASSWORD
    "$JARVIS_JDK/bin/keytool" -genkeypair -keystore "$JARVIS_SIGNING/keystore.p12" -storetype PKCS12 \
        -storepass:env JARVIS_ANDROID_SIGNING_PASSWORD -keypass:env JARVIS_ANDROID_SIGNING_PASSWORD \
        -alias jarvis-development -keyalg RSA -keysize 3072 -validity 3650 \
        -dname 'CN=JARVIS Development, OU=Personal Development, O=JARVIS' -noprompt
fi
JARVIS_ANDROID_SIGNING_PASSWORD="$(cat "$JARVIS_SIGNING/password")"
export JARVIS_ANDROID_SIGNING_PASSWORD
"$JARVIS_SDK_BUILD/apksigner" sign --ks "$JARVIS_SIGNING/keystore.p12" --ks-key-alias jarvis-development \
    --ks-pass env:JARVIS_ANDROID_SIGNING_PASSWORD --key-pass env:JARVIS_ANDROID_SIGNING_PASSWORD \
    --out "$JARVIS_ANDROID_OUTPUT" "$JARVIS_BUILD/aligned.apk"
unset JARVIS_ANDROID_SIGNING_PASSWORD
"$JARVIS_SDK_BUILD/apksigner" verify --verbose "$JARVIS_ANDROID_OUTPUT"
"$JARVIS_SDK_BUILD/zipalign" -c -p 4 "$JARVIS_ANDROID_OUTPUT"
printf 'Installable DEVELOPMENT-signed APK: %s\n' "$JARVIS_ANDROID_OUTPUT"
