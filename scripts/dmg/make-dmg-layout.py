#!/usr/bin/env python3
"""Writes `DS_Store.template`, the Finder window layout of the macOS disk image.

Regenerate (a one-off authoring step; the release build only copies the output):

    uvx --with ds_store --with mac_alias python scripts/dmg/make-dmg-layout.py

or with a throwaway virtual environment:

    venv="$(mktemp -d)" && python3 -m venv "$venv" && "$venv/bin/pip" install ds_store mac_alias
    "$venv/bin/python" scripts/dmg/make-dmg-layout.py

`ds_store` and `mac_alias` are pure Python and never become a build
dependency. The disk image builder copies the template into the staging
folder as `.DS_Store`, so no Finder window has to be driven at build time.

What the template stores: window position and size, no toolbar, status bar,
path bar or sidebar, icon view at 128 points with labels below, the background
picture, and the positions of `Octant.app` and `Applications`. The background
is an alias to `.background/background.tiff` on a volume named `Octant`, so
the image's volume name must stay `Octant`. The alias carries the path and
the volume name, which Finder resolves; its catalog ids are placeholders, as
the file does not exist on any volume at authoring time.

Positions must match `background.svg`: app icon centre (180, 170), Applications
centre (480, 170).

Reading it back: `python scripts/dmg/make-dmg-layout.py --dump`.
"""

import datetime
import os
import sys

from ds_store import DSStore
from mac_alias import (
    ALIAS_FIXED_DISK,
    ALIAS_KIND_FILE,
    Alias,
    TargetInfo,
    VolumeInfo,
)

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "DS_Store.template")

VOLUME_NAME = "Octant"
BACKGROUND_FOLDER = ".background"
BACKGROUND_FILE = "background.tiff"
APP_NAME = "Octant.app"

# Finder's window bounds include the title bar (about 28 points with the
# toolbar hidden), so the content area is the picture's 660 x 400.
WINDOW_ORIGIN = (200, 120)
CONTENT_SIZE = (660, 400)
TITLE_BAR_HEIGHT = 28
ICON_SIZE = 128
APP_ICON_CENTRE = (180, 170)
APPLICATIONS_CENTRE = (480, 170)


def background_alias() -> bytes:
    epoch = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    alias = Alias(
        volume=VolumeInfo(
            VOLUME_NAME, epoch, b"H+", ALIAS_FIXED_DISK, 0, b"\0\0"
        ),
        target=TargetInfo(
            ALIAS_KIND_FILE,
            BACKGROUND_FILE,
            20,  # placeholder folder id; Finder falls back to the path
            21,  # placeholder file id
            epoch,
            b"\0\0\0\0",
            b"\0\0\0\0",
        ),
    )
    alias.target.folder_name = BACKGROUND_FOLDER
    alias.target.carbon_path = f"{VOLUME_NAME}:{BACKGROUND_FOLDER}:{BACKGROUND_FILE}".encode()
    alias.target.posix_path = f"/{BACKGROUND_FOLDER}/{BACKGROUND_FILE}".encode()
    alias.volume.posix_path = f"/Volumes/{VOLUME_NAME}".encode()
    return alias.to_bytes()


def write_template() -> None:
    if os.path.exists(TEMPLATE):
        os.remove(TEMPLATE)
    x, y = WINDOW_ORIGIN
    width, height = CONTENT_SIZE
    with DSStore.open(TEMPLATE, "w+") as store:
        root = store["."]
        root["bwsp"] = {
            "ShowStatusBar": False,
            "ShowPathbar": False,
            "ShowToolbar": False,
            "ShowTabView": False,
            "ShowSidebar": False,
            "ContainerShowSidebar": False,
            "SidebarWidth": 0,
            "WindowBounds": f"{{{{{x}, {y}}}, {{{width}, {height + TITLE_BAR_HEIGHT}}}}}",
        }
        root["icvp"] = {
            "viewOptionsVersion": 1,
            "backgroundType": 2,
            "backgroundImageAlias": background_alias(),
            "backgroundColorRed": 0.0,
            "backgroundColorGreen": 0.0,
            "backgroundColorBlue": 0.0,
            "arrangeBy": "none",
            "gridOffsetX": 0.0,
            "gridOffsetY": 0.0,
            "gridSpacing": 100.0,
            "iconSize": float(ICON_SIZE),
            "textSize": 12.0,
            "labelOnBottom": True,
            "showIconPreview": True,
            "showItemInfo": False,
            "scrollPositionX": 0.0,
            "scrollPositionY": 0.0,
        }
        root["vSrn"] = ("long", 1)
        root["icvl"] = ("type", b"icnv")
        store[APP_NAME]["Iloc"] = APP_ICON_CENTRE
        store["Applications"]["Iloc"] = APPLICATIONS_CENTRE


def dump_template(path: str) -> None:
    from mac_alias import Alias as ReadAlias

    with DSStore.open(path, "r") as store:
        for entry in store:
            value = entry.value
            if entry.code == b"icvp":
                alias = ReadAlias.from_bytes(value["backgroundImageAlias"])
                print(f"{entry.filename!r} icvp iconSize={value['iconSize']} "
                      f"backgroundType={value['backgroundType']}")
                print(f"  background alias: volume={alias.volume.name!r} "
                      f"posix={alias.target.posix_path!r} carbon={alias.target.carbon_path!r}")
            else:
                print(f"{entry.filename!r} {entry.code.decode()} {value!r}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--dump":
        dump_template(sys.argv[2] if len(sys.argv) > 2 else TEMPLATE)
    else:
        write_template()
        print(f"Wrote {TEMPLATE}")
