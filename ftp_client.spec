# -*- mode: python ; coding: utf-8 -*-
import sys as _sys

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('templates', 'templates'),
        ('static', 'static'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ftp-client',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

if _sys.platform == 'darwin':
    BUNDLE(
        exe,
        name='FTP Client.app',
        icon=None,
        bundle_identifier='com.procolocarannante.ftp-client',
        info_plist={
            'CFBundleName': 'FTP Client',
            'CFBundleShortVersionString': '1.2.0',
            'NSHighResolutionCapable': True,
            'LSUIElement': True,
        },
    )
