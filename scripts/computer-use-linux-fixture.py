#!/usr/bin/env python3
"""Small GTK3 top-level used only by the Linux Computer Use CI acceptance."""

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk


window = Gtk.Window(title="PI Computer Use Linux Fixture")
window.set_default_size(560, 360)
layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
layout.set_margin_top(32)
layout.set_margin_start(32)
layout.set_margin_end(32)
layout.set_margin_bottom(32)
status = Gtk.Label(label="Waiting for Computer Use")
status.get_accessible().set_name("Fixture status: Waiting")
button = Gtk.Button(label="Click fixture action")
button.get_accessible().set_name("Fixture action button")
button.connect(
    "clicked",
    lambda _button: (
        status.set_text("Click confirmed by GTK"),
        status.get_accessible().set_name("Fixture status: Click confirmed by GTK"),
    ),
)
layout.pack_start(status, False, False, 0)
layout.pack_start(button, False, False, 0)
window.add(layout)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
