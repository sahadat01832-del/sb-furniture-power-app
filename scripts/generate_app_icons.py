#!/usr/bin/env python3
"""
Generate custom high-resolution Android launcher icons for:
1. SB Furniture & SB POWER (Client & Reseller App)
2. SB Admin Panel App
And update & re-sign dist-apk/*.apk
"""

import os
import shutil
import zipfile
import subprocess
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

def export_android_res_icons(res_dir, icon_type='client'):
    draw_fn = draw_client_icon if icon_type == 'client' else draw_admin_icon
    print(f"Exporting {icon_type} icons to {res_dir}...")
    
    for folder, px in MIPMAP_SIZES.items():
        out_dir = os.path.join(res_dir, folder)
        os.makedirs(out_dir, exist_ok=True)
        
        # ic_launcher.png (square/squircle)
        img_sq = draw_fn(px, is_round=False, is_foreground=False)
        img_sq.save(os.path.join(out_dir, 'ic_launcher.png'), 'PNG')
        
        # ic_launcher_round.png
        img_rd = draw_fn(px, is_round=True, is_foreground=False)
        img_rd.save(os.path.join(out_dir, 'ic_launcher_round.png'), 'PNG')
        
        # ic_launcher_foreground.png
        img_fg = draw_fn(px, is_round=False, is_foreground=True)
        img_fg.save(os.path.join(out_dir, 'ic_launcher_foreground.png'), 'PNG')

def update_apk_icons(apk_path, icon_type='client'):
    """Inject new icons into existing APK and re-sign with uber-apk-signer"""
    if not os.path.exists(apk_path):
        print(f"Warning: {apk_path} does not exist.")
        return

    print(f"Injecting custom {icon_type} icons into {apk_path}...")
    draw_fn = draw_client_icon if icon_type == 'client' else draw_admin_icon
    
    # Prepare temp icons
    temp_dir = os.path.join(ROOT_DIR, 'tmp_apk_icons')
    os.makedirs(temp_dir, exist_ok=True)
    
    icon_replacements = {}
    
    apk_zip = zipfile.ZipFile(apk_path, 'r')
    existing_files = apk_zip.namelist()
    apk_zip.close()
    
    # Map resolution folders inside APK
    res_map = {
        'res/mipmap-mdpi-v4': 48,
        'res/mipmap-hdpi-v4': 72,
        'res/mipmap-xhdpi-v4': 96,
        'res/mipmap-xxhdpi-v4': 144,
        'res/mipmap-xxxhdpi-v4': 192,
    }
    
    for folder, px in res_map.items():
        sq_img = draw_fn(px, is_round=False, is_foreground=False)
        rd_img = draw_fn(px, is_round=True, is_foreground=False)
        fg_img = draw_fn(px, is_round=False, is_foreground=True)
        
        sq_path = os.path.join(temp_dir, f"{px}_sq.png")
        rd_path = os.path.join(temp_dir, f"{px}_rd.png")
        fg_path = os.path.join(temp_dir, f"{px}_fg.png")
        
        sq_img.save(sq_path, 'PNG')
        rd_img.save(rd_path, 'PNG')
        fg_img.save(fg_path, 'PNG')
        
        p1 = f"{folder}/ic_launcher.png"
        p2 = f"{folder}/ic_launcher_round.png"
        p3 = f"{folder}/ic_launcher_foreground.png"
        
        if p1 in existing_files:
            icon_replacements[p1] = sq_path
        if p2 in existing_files:
            icon_replacements[p2] = rd_path
        if p3 in existing_files:
            icon_replacements[p3] = fg_path

    # Unpack, replace, repack
    unpack_dir = os.path.join(ROOT_DIR, 'tmp_apk_unpacked')
    if os.path.exists(unpack_dir):
        shutil.rmtree(unpack_dir)
    os.makedirs(unpack_dir)
    
    with zipfile.ZipFile(apk_path, 'r') as zin:
        zin.extractall(unpack_dir)
        
    for in_apk_path, local_img in icon_replacements.items():
        dest = os.path.join(unpack_dir, in_apk_path)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(local_img, dest)
        
    # Remove existing signatures from META-INF so re-signing succeeds cleanly
    meta_inf = os.path.join(unpack_dir, 'META-INF')
    if os.path.exists(meta_inf):
        for f in os.listdir(meta_inf):
            if f.endswith('.RSA') or f.endswith('.DSA') or f.endswith('.SF') or f.endswith('.MF'):
                os.remove(os.path.join(meta_inf, f))
                
    # Repack zip
    temp_apk = apk_path + ".unsigned.apk"
    if os.path.exists(temp_apk):
        os.remove(temp_apk)
        
    with zipfile.ZipFile(temp_apk, 'w', zipfile.ZIP_DEFLATED) as zout:
        for root, dirs, files in os.walk(unpack_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, unpack_dir)
                zout.write(full_path, rel_path)
                
    # Sign with uber-apk-signer
    signer_jar = os.path.join(ROOT_DIR, 'scripts', 'uber-apk-signer.jar')
    java_bin = '/home/don/.local/bin/java'
    
    signed_dir = os.path.join(ROOT_DIR, 'tmp_signed')
    if os.path.exists(signed_dir):
        shutil.rmtree(signed_dir)
    os.makedirs(signed_dir)
    
    print("Signing APK with debug key...")
    cmd = [java_bin, '-jar', signer_jar, '-a', temp_apk, '--overwrite', '--allowResign']
    subprocess.check_call(cmd)
    
    # temp_apk is now signed in-place, move it to apk_path
    shutil.move(temp_apk, apk_path)
    print(f"✅ Successfully updated & signed: {apk_path}")
        
    # Clean up
    shutil.rmtree(temp_dir, ignore_errors=True)
    shutil.rmtree(unpack_dir, ignore_errors=True)

def main():
    print("--- Generating Custom App Logos ---")
    
    # 1. Update public/icons/playstore-icon.png and icons
    playstore_icon = draw_client_icon(512, is_round=False)
    playstore_icon.save(os.path.join(ROOT_DIR, 'public', 'icons', 'playstore-icon.png'), 'PNG')
    playstore_icon.save(os.path.join(ROOT_DIR, 'public', 'icons', 'icon-512.png'), 'PNG')
    draw_client_icon(192).save(os.path.join(ROOT_DIR, 'public', 'icons', 'icon-192.png'), 'PNG')
    
    admin_icon = draw_admin_icon(512, is_round=False)
    admin_icon.save(os.path.join(ROOT_DIR, 'public', 'icons', 'admin-icon-512.png'), 'PNG')
    
    # 2. Update Android Projects
    for android_dir in ['android', 'android-client']:
        target_res = os.path.join(ROOT_DIR, android_dir, 'app', 'src', 'main', 'res')
        if os.path.exists(target_res):
            export_android_res_icons(target_res, icon_type='client')
            
    for admin_dir in ['android-admin']:
        target_res = os.path.join(ROOT_DIR, admin_dir, 'app', 'src', 'main', 'res')
        if os.path.exists(target_res):
            export_android_res_icons(target_res, icon_type='admin')
            
    # 3. Update & re-sign APK binaries
    reseller_apk = os.path.join(ROOT_DIR, 'dist-apk', 'sb-power-reseller.apk')
    admin_apk = os.path.join(ROOT_DIR, 'dist-apk', 'sb-power-admin.apk')
    
    update_apk_icons(reseller_apk, icon_type='client')
    update_apk_icons(admin_apk, icon_type='admin')
    
    print("All icons generated and APKs re-signed successfully!")

if __name__ == '__main__':
    main()
