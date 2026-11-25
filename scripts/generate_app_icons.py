#!/usr/bin/env python3
"""
Generate custom high-resolution Android launcher icons for:
1. SB Furniture & SB POWER (Client & Reseller App)
2. SB Admin Panel App
And update & re-sign dist-apk/*.apk
"""

import os
import shutil
import tempfile
import zipfile
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MIPMAP_SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}
FOREGROUND_SIZE = 432

def get_font(size):
    font_paths = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'
    ]
    for p in font_paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

def draw_client_icon(size, is_round=False, is_foreground=False):
    """Client & Reseller App Icon"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if not is_foreground:
        # Background
        bg_color = (28, 25, 23, 255) # #1c1917 Dark Charcoal
        border_gold = (180, 83, 9, 255) # #b45309 Amber Gold
        
        if is_round:
            draw.ellipse([2, 2, size - 3, size - 3], fill=bg_color, outline=border_gold, width=max(2, int(size * 0.04)))
        else:
            r = int(size * 0.22)
            draw.rounded_rectangle([2, 2, size - 3, size - 3], radius=r, fill=bg_color, outline=border_gold, width=max(2, int(size * 0.04)))

    # Scale factor
    scale = size / 512.0

    # Draw Sofa/Chair silhouette in Gold
    sofa_y = int(140 * scale) if is_foreground else int(115 * scale)
    sofa_w = int(220 * scale)
    sofa_h = int(95 * scale)
    sofa_x = (size - sofa_w) // 2

    # Sofa backrest
    draw.rounded_rectangle([sofa_x, sofa_y, sofa_x + sofa_w, sofa_y + int(55 * scale)], radius=int(12 * scale), fill=(217, 119, 6, 255))
    # Sofa seat cushion
    draw.rounded_rectangle([sofa_x - int(10 * scale), sofa_y + int(35 * scale), sofa_x + sofa_w + int(10 * scale), sofa_y + sofa_h], radius=int(10 * scale), fill=(245, 158, 11, 255))
    # Sofa armrests
    draw.rounded_rectangle([sofa_x - int(15 * scale), sofa_y + int(20 * scale), sofa_x + int(10 * scale), sofa_y + sofa_h], radius=int(8 * scale), fill=(180, 83, 9, 255))
    draw.rounded_rectangle([sofa_x + sofa_w - int(10 * scale), sofa_y + int(20 * scale), sofa_x + sofa_w + int(15 * scale), sofa_y + sofa_h], radius=int(8 * scale), fill=(180, 83, 9, 255))

    # Bold Letters "SB"
    font_size_sb = int(135 * scale)
    font_sb = get_font(font_size_sb)
    text_sb = "SB"
    bbox_sb = draw.textbbox((0, 0), text_sb, font=font_sb)
    w_sb = bbox_sb[2] - bbox_sb[0]
    x_sb = (size - w_sb) // 2
    y_sb = sofa_y + sofa_h + int(5 * scale)

    # Shadow
    draw.text((x_sb + int(3 * scale), y_sb + int(3 * scale)), text_sb, font=font_sb, fill=(10, 10, 10, 200))
    # Text fill (High-Contrast Electric Yellow #facc15)
    draw.text((x_sb, y_sb), text_sb, font=font_sb, fill=(250, 204, 21, 255))

    # Subtext "FURNITURE & POWER"
    font_size_sub = int(28 * scale)
    font_sub = get_font(font_size_sub)
    text_sub = "FURNITURE & POWER"
    bbox_sub = draw.textbbox((0, 0), text_sub, font=font_sub)
    w_sub = bbox_sub[2] - bbox_sub[0]
    x_sub = (size - w_sub) // 2
    y_sub = y_sb + int(120 * scale)

    draw.text((x_sub, y_sub), text_sub, font=font_sub, fill=(255, 255, 255, 255))

    # Electric Power Bolt Accent
    bolt_x = sofa_x + sofa_w + int(22 * scale)
    bolt_y = sofa_y - int(10 * scale)
    bolt_pts = [
        (bolt_x, bolt_y),
        (bolt_x - int(15 * scale), bolt_y + int(30 * scale)),
        (bolt_x - int(4 * scale), bolt_y + int(30 * scale)),
        (bolt_x - int(12 * scale), bolt_y + int(55 * scale)),
        (bolt_x + int(12 * scale), bolt_y + int(22 * scale)),
        (bolt_x + int(2 * scale), bolt_y + int(22 * scale))
    ]
    draw.polygon(bolt_pts, fill=(6, 182, 212, 255)) # Electric Cyan #06b6d4

    return img

def draw_admin_icon(size, is_round=False, is_foreground=False):
    """Admin Control App Icon"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if not is_foreground:
        bg_color = (15, 23, 42, 255) # Slate 900
        border_color = (234, 179, 8, 255) # Gold
        
        if is_round:
            draw.ellipse([2, 2, size - 3, size - 3], fill=bg_color, outline=border_color, width=max(2, int(size * 0.05)))
        else:
            r = int(size * 0.22)
            draw.rounded_rectangle([2, 2, size - 3, size - 3], radius=r, fill=bg_color, outline=border_color, width=max(2, int(size * 0.05)))

    scale = size / 512.0

    # Shield / Crown icon in Gold
    top_y = int(90 * scale) if is_foreground else int(70 * scale)
    crown_w = int(200 * scale)
    crown_h = int(100 * scale)
    cx = (size - crown_w) // 2

    # Draw Crown/Dashboard shape
    crown_pts = [
        (cx, top_y + crown_h),
        (cx, top_y + int(30 * scale)),
        (cx + int(50 * scale), top_y + int(60 * scale)),
        (cx + int(100 * scale), top_y + int(10 * scale)),
        (cx + int(150 * scale), top_y + int(60 * scale)),
        (cx + crown_w, top_y + int(30 * scale)),
        (cx + crown_w, top_y + crown_h)
    ]
    draw.polygon(crown_pts, fill=(234, 179, 8, 255))

    # Bold "SB"
    font_size_sb = int(120 * scale)
    font_sb = get_font(font_size_sb)
    text_sb = "SB"
    bbox_sb = draw.textbbox((0, 0), text_sb, font=font_sb)
    w_sb = bbox_sb[2] - bbox_sb[0]
    x_sb = (size - w_sb) // 2
    y_sb = top_y + crown_h + int(10 * scale)

    draw.text((x_sb, y_sb), text_sb, font=font_sb, fill=(255, 255, 255, 255))

    # "ADMIN" Pill badge
    badge_w = int(240 * scale)
    badge_h = int(60 * scale)
    badge_x = (size - badge_w) // 2
    badge_y = y_sb + int(115 * scale)

    draw.rounded_rectangle([badge_x, badge_y, badge_x + badge_w, badge_y + badge_h], radius=int(14 * scale), fill=(16, 185, 129, 255)) # Emerald Green

    font_size_admin = int(36 * scale)
    font_admin = get_font(font_size_admin)
    text_admin = "ADMIN"
    bbox_admin = draw.textbbox((0, 0), text_admin, font=font_admin)
    w_admin = bbox_admin[2] - bbox_admin[0]
    x_admin = (size - w_admin) // 2
    y_admin = badge_y + int(10 * scale)

    draw.text((x_admin, y_admin), text_admin, font=font_admin, fill=(255, 255, 255, 255))

    return img

def build_launcher_variant(size, icon_type='client', is_round=False, is_foreground=False):
    """Build Android launcher icon from SVG-rendered brand PNGs when available, else fallback."""
    source_name = 'icon-512.png' if icon_type == 'client' else 'admin-icon-512.png'
    source_path = os.path.join(ROOT_DIR, 'public', 'icons', source_name)
    if not os.path.isfile(source_path):
        draw_fn = draw_client_icon if icon_type == 'client' else draw_admin_icon
        return draw_fn(size, is_round=is_round, is_foreground=is_foreground)

    base = Image.open(source_path).convert('RGBA')
    resample = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS

    if is_foreground:
        # Adaptive icons show central ~66-72% safe area cleanly without clipping edges
        inner = max(1, int(size * 0.72))
        resized = base.resize((inner, inner), resample)
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        offset = (size - inner) // 2
        canvas.paste(resized, (offset, offset), resized)
        return canvas

    resized = base.resize((size, size), resample)
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    if is_round:
        mask_draw.ellipse([0, 0, size - 1, size - 1], fill=255)
    else:
        mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=max(2, int(size * 0.22)), fill=255)
    resized.putalpha(mask)
    return resized

def export_android_res_icons(res_dir, icon_type='client'):
    print(f"Exporting {icon_type} icons to {res_dir}...")

    for folder, px in MIPMAP_SIZES.items():
        out_dir = os.path.join(res_dir, folder)
        os.makedirs(out_dir, exist_ok=True)

        # ic_launcher.png (square/squircle)
        build_launcher_variant(px, icon_type=icon_type, is_round=False, is_foreground=False).save(
            os.path.join(out_dir, 'ic_launcher.png'), 'PNG'
        )

        # ic_launcher_round.png
        build_launcher_variant(px, icon_type=icon_type, is_round=True, is_foreground=False).save(
            os.path.join(out_dir, 'ic_launcher_round.png'), 'PNG'
        )

        # ic_launcher_foreground.png
        build_launcher_variant(px, icon_type=icon_type, is_round=False, is_foreground=True).save(
            os.path.join(out_dir, 'ic_launcher_foreground.png'), 'PNG'
        )

def find_android_tool(name):
    tool = shutil.which(name)
    if tool:
        return tool

    for sdk in [os.environ.get('ANDROID_SDK_ROOT'), os.environ.get('ANDROID_HOME')]:
        if not sdk:
            continue
        build_tools = os.path.join(sdk, 'build-tools')
        if not os.path.isdir(build_tools):
            continue
        for version in sorted(os.listdir(build_tools), reverse=True):
            candidate = os.path.join(build_tools, version, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
    return None


def update_apk_icons(apk_path, icon_type='client'):
    """Replace launcher icons, align, and sign with credentials supplied outside the repository."""
    if not os.path.exists(apk_path):
        raise FileNotFoundError(f"APK was not produced for the requested target: {apk_path}")

    keystore_path = os.environ.get('ANDROID_KEYSTORE_PATH', '').strip()
    keystore_alias = os.environ.get('ANDROID_KEYSTORE_ALIAS', '').strip()
    required_credentials = ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_PASSWORD']
    if not keystore_path or not keystore_alias or any(not os.environ.get(key) for key in required_credentials):
        raise RuntimeError('Set ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_ALIAS, ANDROID_KEYSTORE_PASSWORD, and ANDROID_KEY_PASSWORD before signing an APK.')

    keystore_path = os.path.realpath(keystore_path)
    if os.path.commonpath([ROOT_DIR, keystore_path]) == ROOT_DIR:
        raise RuntimeError('The release keystore must be stored outside the project directory.')
    if not os.path.isfile(keystore_path):
        raise RuntimeError('The configured release keystore file was not found.')

    apksigner = find_android_tool('apksigner')
    zipalign = find_android_tool('zipalign')
    if not apksigner or not zipalign:
        raise RuntimeError('Android SDK build-tools with apksigner and zipalign are required to sign APKs.')

    print(f"Injecting custom {icon_type} icons and signing the APK with the configured external key...")
    res_map = {
        'res/mipmap-mdpi-v4': 48,
        'res/mipmap-hdpi-v4': 72,
        'res/mipmap-xhdpi-v4': 96,
        'res/mipmap-xxhdpi-v4': 144,
        'res/mipmap-xxxhdpi-v4': 192,
    }

    with tempfile.TemporaryDirectory(prefix='sb-power-apk-') as temp_dir:
        replacements = {}
        for folder, px in res_map.items():
            for filename, image in [
                ('ic_launcher.png', build_launcher_variant(px, icon_type=icon_type, is_round=False, is_foreground=False)),
                ('ic_launcher_round.png', build_launcher_variant(px, icon_type=icon_type, is_round=True, is_foreground=False)),
                ('ic_launcher_foreground.png', build_launcher_variant(px, icon_type=icon_type, is_round=False, is_foreground=True)),
            ]:
                image_path = os.path.join(temp_dir, f'{px}-{filename}')
                image.save(image_path, 'PNG')
                replacements[f'{folder}/{filename}'] = image_path

        unsigned_apk = os.path.join(temp_dir, 'updated-unsigned.apk')
        replaced_count = 0
        with zipfile.ZipFile(apk_path, 'r') as source:
            with zipfile.ZipFile(unsigned_apk, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as output:
                for info in source.infolist():
                    name = info.filename
                    upper_name = name.upper()
                    if name.startswith('META-INF/') and upper_name.endswith(('.RSA', '.DSA', '.SF', '.MF')):
                        continue
                    replacement_path = replacements.get(name)
                    if replacement_path:
                        with open(replacement_path, 'rb') as replacement_file:
                            content = replacement_file.read()
                        replaced_count += 1
                    else:
                        content = source.read(name)
                    output.writestr(info, content)

        if replaced_count == 0:
            raise RuntimeError('No launcher icons were found in the APK.')

        aligned_apk = os.path.join(temp_dir, 'updated-aligned.apk')
        signed_apk = os.path.join(temp_dir, 'updated-signed.apk')
        subprocess.run([zipalign, '-f', '4', unsigned_apk, aligned_apk], check=True)
        subprocess.run([
            apksigner, 'sign',
            '--ks', keystore_path,
            '--ks-key-alias', keystore_alias,
            '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD',
            '--key-pass', 'env:ANDROID_KEY_PASSWORD',
            '--v1-signing-enabled', 'true',
            '--v2-signing-enabled', 'true',
            '--v3-signing-enabled', 'true',
            '--out', signed_apk,
            aligned_apk,
        ], check=True)
        subprocess.run([apksigner, 'verify', '--verbose', signed_apk], check=True, stdout=subprocess.DEVNULL)

        descriptor, staged_apk = tempfile.mkstemp(prefix='.sb-power-apk-', suffix='.tmp', dir=os.path.dirname(apk_path))
        os.close(descriptor)
        try:
            shutil.copyfile(signed_apk, staged_apk)
            os.replace(staged_apk, apk_path)
        finally:
            if os.path.exists(staged_apk):
                os.unlink(staged_apk)

    print(f"✅ Successfully updated and verified: {apk_path}")

def main(targets=None):
    targets = targets or []
    invalid_targets = set(targets) - {'client', 'admin'}
    if invalid_targets:
        raise ValueError('Targets must be client and/or admin.')

    print("--- Generating Custom App Logos ---")

    # 1. Preserve SVG-rendered web/PWA icons if present; sync playstore-icon.png cleanly
    icons_dir = os.path.join(ROOT_DIR, 'public', 'icons')
    client_512_path = os.path.join(icons_dir, 'icon-512.png')
    client_192_path = os.path.join(icons_dir, 'icon-192.png')
    admin_512_path = os.path.join(icons_dir, 'admin-icon-512.png')
    playstore_path = os.path.join(icons_dir, 'playstore-icon.png')

    if os.path.isfile(client_512_path):
        shutil.copyfile(client_512_path, playstore_path)
    else:
        playstore_icon = draw_client_icon(512, is_round=False)
        playstore_icon.save(playstore_path, 'PNG')
        playstore_icon.save(client_512_path, 'PNG')

    if not os.path.isfile(client_192_path):
        draw_client_icon(192).save(client_192_path, 'PNG')

    if not os.path.isfile(admin_512_path):
        draw_admin_icon(512, is_round=False).save(admin_512_path, 'PNG')
    
    # 2. Update Android Projects
    for android_dir in ['android', 'android-client']:
        target_res = os.path.join(ROOT_DIR, android_dir, 'app', 'src', 'main', 'res')
        if os.path.exists(target_res):
            export_android_res_icons(target_res, icon_type='client')
            
    for admin_dir in ['android-admin']:
        target_res = os.path.join(ROOT_DIR, admin_dir, 'app', 'src', 'main', 'res')
        if os.path.exists(target_res):
            export_android_res_icons(target_res, icon_type='admin')
            
    # 3. Update only APKs built during this invocation.
    if 'client' in targets:
        update_apk_icons(os.path.join(ROOT_DIR, 'dist-apk', 'sb-power-reseller.apk'), icon_type='client')
    if 'admin' in targets:
        update_apk_icons(os.path.join(ROOT_DIR, 'dist-apk', 'sb-power-admin.apk'), icon_type='admin')

    if targets:
        print("All requested APK icons were updated and their signatures verified.")
    else:
        print("Web and Android project icons generated; no existing APK was changed.")

if __name__ == '__main__':
    main(sys.argv[1:])
