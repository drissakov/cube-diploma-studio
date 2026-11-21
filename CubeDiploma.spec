# Build with Python 3.12 x64 and PyInstaller 6.22.3 on Windows.
from importlib.metadata import distribution
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_submodules

app = Path(SPECPATH)
data = [(str(app / name), name) for name in ("web", "assets")]
for package in ("pillow", "pypdf", "pypdfium2", "reportlab", "charset-normalizer", "pyinstaller"):
    dist = distribution(package)
    for filename in dist.files or ():
        parts = filename.parts
        if "licenses" in parts and parts[0].endswith(".dist-info"):
            relative = Path(*parts[parts.index("licenses") + 1:])
            data.append((str(dist.locate_file(filename)), str(Path("notices") / package / relative.parent)))
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if python_license.is_file():
    data.append((str(python_license), "notices/Python"))

# ReportLab loads its barcode widgets by module name while initializing the QR encoder.
barcodes = collect_submodules("reportlab.graphics.barcode", filter=lambda module: not module.endswith(".test"))
analysis = Analysis([str(app / "server.py")], pathex=[str(app)], datas=data, hiddenimports=barcodes,
                    excludes=["tkinter", "unittest", "pytest", "numpy", "matplotlib", "IPython"])
pyz = PYZ(analysis.pure)
exe = EXE(pyz, analysis.scripts, analysis.binaries, analysis.datas, [], name="CubeDiploma-2",
          console=False, upx=False, icon=str(app / "icon.ico"))
