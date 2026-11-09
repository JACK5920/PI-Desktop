import AppKit
import CryptoKit
import Foundation

final class PointerProbeButton: NSButton {
    var onPointerEvent: ((String) -> Void)?
    private var trackingArea: NSTrackingArea?

    override func updateTrackingAreas() {
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) {
        onPointerEvent?("entered")
        super.mouseEntered(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        onPointerEvent?("exited")
        super.mouseExited(with: event)
    }

    override func mouseDown(with event: NSEvent) {
        onPointerEvent?("down")
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        onPointerEvent?("dragged")
        super.mouseDragged(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        onPointerEvent?("up")
        super.mouseUp(with: event)
    }
}

final class ComputerUseFixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let stateURL: URL
    private let commandURL: URL
    private let targetTitle: String
    private let otherTitle: String
    private var targetWindow: NSWindow!
    private var otherWindow: NSWindow!
    private var normalField: NSTextField!
    private var secureField: NSSecureTextField!
    private var otherField: NSTextField!
    private var pointerButton: PointerProbeButton!
    private var pointerEntered = false
    private var dragStarted = false
    private var dragMoved = false
    private var dragEnded = false
    private var lastCommandSequence = 0

    init(statePath: String, commandPath: String, targetTitle: String, otherTitle: String) {
        stateURL = URL(fileURLWithPath: statePath)
        commandURL = URL(fileURLWithPath: commandPath)
        self.targetTitle = targetTitle
        self.otherTitle = otherTitle
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        targetWindow = makeWindow(title: targetTitle, size: NSSize(width: 560, height: 300))
        normalField = NSTextField(string: "")
        normalField.setAccessibilityLabel("CU normal text field")
        normalField.accessibilityIdentifier = "computerUseNormalTextField"
        normalField.delegate = self
        secureField = NSSecureTextField(string: "")
        secureField.setAccessibilityLabel("CU secure text field")
        secureField.accessibilityIdentifier = "computerUseSecureTextField"
        pointerButton = PointerProbeButton(title: "CU pointer probe", target: nil, action: nil)
        pointerButton.setAccessibilityLabel("CU pointer probe")
        pointerButton.onPointerEvent = { [weak self] event in self?.recordPointerEvent(event) }
        targetWindow.contentView = makeStack([
            label("Computer Use isolated native fixture"),
            pointerButton,
            label("Ordinary editable field"),
            normalField,
            label("Secure field; test input must be refused"),
            secureField,
        ])
        targetWindow.center()
        targetWindow.makeKeyAndOrderFront(nil)

        otherWindow = makeWindow(title: otherTitle, size: NSSize(width: 420, height: 180))
        otherField = NSTextField(string: "Different window; do not type here")
        otherField.isEditable = false
        otherField.setAccessibilityLabel("CU other window field")
        otherWindow.contentView = makeStack([label("Focus-mismatch test window"), otherField])
        otherWindow.center()
        NSApplication.shared.activate(ignoringOtherApps: true)
        _ = targetWindow.makeFirstResponder(normalField)

        Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            self?.consumeCommand()
        }
        writeState()
    }

    func controlTextDidChange(_ notification: Notification) {
        writeState()
    }

    private func recordPointerEvent(_ event: String) {
        switch event {
        case "entered": pointerEntered = true
        case "down": dragStarted = true
        case "dragged": dragMoved = true
        case "up": dragEnded = true
        default: break
        }
        writeState()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func makeWindow(title: String, size: NSSize) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        return window
    }

    private func makeStack(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fill
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        return stack
    }

    private func label(_ value: String) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.setAccessibilityLabel(value)
        return field
    }

    private func consumeCommand() {
        guard let data = try? Data(contentsOf: commandURL),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sequence = command["sequence"] as? Int,
              sequence > lastCommandSequence,
              let name = command["name"] as? String
        else { return }

        lastCommandSequence = sequence
        switch name {
        case "focus_target":
            NSApplication.shared.activate(ignoringOtherApps: true)
            targetWindow.makeKeyAndOrderFront(nil)
            _ = targetWindow.makeFirstResponder(normalField)
        case "focus_other":
            NSApplication.shared.activate(ignoringOtherApps: true)
            otherWindow.makeKeyAndOrderFront(nil)
            _ = otherWindow.makeFirstResponder(otherField)
        case "focus_secure":
            NSApplication.shared.activate(ignoringOtherApps: true)
            targetWindow.makeKeyAndOrderFront(nil)
            _ = targetWindow.makeFirstResponder(secureField)
        case "clear_secure":
            secureField.stringValue = ""
        case "reset_pointer":
            pointerEntered = false
            dragStarted = false
            dragMoved = false
            dragEnded = false
        case "stop":
            NSApplication.shared.terminate(nil)
        default:
            break
        }
        writeState()
    }

    private func writeState() {
        let digest = SHA256.hash(data: Data(normalField.stringValue.utf8))
        let normalHash = digest.map { String(format: "%02x", $0) }.joined()
        let state: [String: Any] = [
            "ready": targetWindow != nil && targetWindow.isVisible,
            "commandSequence": lastCommandSequence,
            "activeWindow": targetWindow.isKeyWindow ? "target" : (otherWindow?.isKeyWindow == true ? "other" : "none"),
            "secureFocused": targetWindow.firstResponder === secureField,
            "pointerEntered": pointerEntered,
            "dragStarted": dragStarted,
            "dragMoved": dragMoved,
            "dragEnded": dragEnded,
            "normalHash": normalHash,
            "normalLength": normalField.stringValue.count,
            "secureNonEmpty": !secureField.stringValue.isEmpty,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name),
          CommandLine.arguments.indices.contains(index + 1)
    else { return nil }
    return CommandLine.arguments[index + 1]
}

guard let statePath = argument("--state"),
      let commandPath = argument("--command"),
      let targetTitle = argument("--title"),
      let otherTitle = argument("--other-title")
else {
    fputs("fixture requires --state, --command, --title, and --other-title\n", stderr)
    exit(2)
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let fixture = ComputerUseFixture(
    statePath: statePath,
    commandPath: commandPath,
    targetTitle: targetTitle,
    otherTitle: otherTitle
)
application.delegate = fixture
application.run()
