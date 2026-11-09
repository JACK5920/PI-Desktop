#!/usr/bin/env python3
"""Small GTK3 top-level used only by the Linux Computer Use CI acceptance."""

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk


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
key_target = Gtk.Entry()
key_target.get_accessible().set_name("Fixture key target")
key_target.connect("changed", lambda entry: update_key_status(entry.get_text()))


def update_key_status(text):
    status.set_text(f"Key input received: {text}")
    status.get_accessible().set_name(f"Fixture status: Key input received: {text}")


pointer_target = Gtk.EventBox()
pointer_target.set_size_request(240, 72)
pointer_target.get_accessible().set_name("Fixture pointer target")
pointer_target.add_events(
    Gdk.EventMask.ENTER_NOTIFY_MASK
    | Gdk.EventMask.BUTTON_PRESS_MASK
    | Gdk.EventMask.BUTTON_RELEASE_MASK
    | Gdk.EventMask.POINTER_MOTION_MASK
    | Gdk.EventMask.BUTTON1_MOTION_MASK
)
pointer_label = Gtk.Label(label="Pointer target waiting")
pointer_target.add(pointer_label)
drag = {"active": False, "moved": False, "start": None}


def on_pointer_enter(_widget, _event):
    status.set_text("Hover confirmed by GTK")
    status.get_accessible().set_name("Fixture status: Hover confirmed by GTK")
    return False


def on_pointer_press(_widget, event):
    if event.button == 1:
        drag["active"] = True
        drag["moved"] = False
        drag["start"] = (event.x, event.y)
    return False


def on_pointer_motion(_widget, event):
    if drag["active"] and drag["start"] is not None:
        start_x, start_y = drag["start"]
        if abs(event.x - start_x) + abs(event.y - start_y) >= 12:
            drag["moved"] = True
    else:
        status.set_text("Hover confirmed by GTK")
        status.get_accessible().set_name("Fixture status: Hover confirmed by GTK")
    return False


def on_pointer_release(_widget, event):
    if event.button == 1 and drag["active"]:
        if drag["moved"]:
            status.set_text("Drag confirmed by GTK")
            status.get_accessible().set_name("Fixture status: Drag confirmed by GTK")
        drag["active"] = False
        drag["start"] = None
    return False


pointer_target.connect("enter-notify-event", on_pointer_enter)
pointer_target.connect("button-press-event", on_pointer_press)
pointer_target.connect("motion-notify-event", on_pointer_motion)
pointer_target.connect("button-release-event", on_pointer_release)
layout.pack_start(status, False, False, 0)
layout.pack_start(button, False, False, 0)
layout.pack_start(key_target, False, False, 0)
layout.pack_start(pointer_target, False, False, 0)
window.add(layout)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
