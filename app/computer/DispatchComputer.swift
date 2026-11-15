// Dispatch computer use: an agent clicks and types in another Mac app, the safe way (kanban task-jz1q).
//
//   dispatch-computer check                  can this app (the one the agent runs in) use other apps?
//   dispatch-computer apps                   the apps that are open
//   dispatch-computer version                {"protocol": N}: the commands this helper knows (the CLI wants PROTOCOL)
//   dispatch-computer serve --app A --agent claude --why "…" --socket S --state F [--icon-font F --icon-char C]
//
// `serve` is one session. It asks the person first (a small window: which agent, which app, why), and
// only after Allow does it act, and only on that one app. While it works a bar at the top of the screen
// says what it is doing and has a Stop button; Esc anywhere stops it too. Commands come over a unix
// socket from `dispatch computer …` (app/cli/computer.py), one JSON line each:
//   look {screenshot?, path?, frames?}  click {index | x, y; button?, count?}  fill {index, value}  type {text}
//   press {key}  scroll {direction, amount?}  drag {from, to} (each {index} or {x, y})  menu {path?}  stop  ping
// Points (x, y) are in points from the top-left corner of the app's front window, the same space
// `look {frames}` prints; a click or drag only lands when the point is on that app.
// The session ends on Stop, Esc, `stop`, ten minutes without a command, or when the app quits; the
// state file says why. Terminals, code editors, Dispatch itself, System Settings and password apps are
// refused: they reach further than the one app the person approved. So are the Apple menu and Services
// in the app's menu bar (shut down, log out, other apps). While the screen is locked apps show no
// windows and nobody can answer, so `serve` and every command say that in plain words instead of waiting.
//
// Reading and acting go through the macOS Accessibility interface, so the app the agent runs in
// (Dispatch IDE, or the terminal) needs the Accessibility permission once; without it `serve` explains
// that in plain words and offers to open the right page of System Settings. Screenshots of the app's
// window also need Screen Recording; everything else works without it.
//
// Tests: `dispatch-computer practice --out F` is a tiny app ("Practice Notes": a note field, a Save
// button) to drive instead of a real one; with DISPATCH_COMPUTER_SELFTEST=1 `serve` accepts it and
// `ui {button}` / `render {dir}` press and picture this helper's own windows, and
// DISPATCH_COMPUTER_OFFSCREEN=1 keeps every window of a test off the screen, and
// DISPATCH_COMPUTER_PRETEND_LOCKED=<file> makes the screen count as locked while that file exists.
//
// Build: swiftc -O -swift-version 5 -o dispatch-computer DispatchComputer.swift

import AppKit
import ApplicationServices
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Small helpers

let selfTest = ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_SELFTEST"] == "1"
let offscreen = ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_OFFSCREEN"] == "1"
let practiceAppName = "Practice Notes"
/// The commands this helper knows; the CLI compiles a newer helper from source when the one it found is older.
let helperProtocol = 3

func jsonLine(_ obj: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
    return String(data: data, encoding: .utf8) ?? "{}"
}

func printJSON(_ obj: [String: Any]) {
    print(jsonLine(obj))
    fflush(stdout)
}

func argValue(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func writeState(_ path: String, _ obj: [String: Any]) {
    var o = obj
    o["pid"] = Int(getpid())
    o["at"] = Date().timeIntervalSince1970
    let tmp = path + ".tmp"
    try? jsonLine(o).write(toFile: tmp, atomically: false, encoding: .utf8)
    _ = rename(tmp, path)
}

func short(_ s: String, _ n: Int = 80) -> String {
    let flat = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    return flat.count > n ? String(flat.prefix(n - 1)) + "…" : flat
}

/// The app this process belongs to for macOS permissions: the outermost `.app` among its ancestors
/// (Dispatch IDE for an agent in the Agents window, Terminal or Ghostty for one in a terminal).
func hostAppName() -> String {
    // macOS asks the "responsible" app for permissions: the app that started this chain of processes
    typealias Responsible = @convention(c) (pid_t) -> pid_t
    if let h = dlopen(nil, RTLD_NOW), let sym = dlsym(h, "responsibility_get_pid_responsible_for_pid") {
        let rp = unsafeBitCast(sym, to: Responsible.self)(getpid())
        if rp > 0, rp != getpid(), let app = NSRunningApplication(processIdentifier: rp), let name = app.localizedName, !name.isEmpty {
            return name
        }
    }
    var pid = getppid()
    var outermost: String?
    for _ in 0..<40 {
        if pid <= 1 { break }
        var buf = [CChar](repeating: 0, count: 4096)
        let found = proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : NSRunningApplication(processIdentifier: pid)?.bundleURL?.path
        if let path = found.map({ $0.hasSuffix(".app") ? $0 + "/" : $0 }) {
            if let r = path.range(of: ".app/") {
                let appPath = String(path[..<r.lowerBound]) + ".app"
                outermost = appPath
            }
        }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        if sysctl(&mib, 4, &info, &size, nil, 0) != 0 { break }
        pid = info.kp_eproc.e_ppid
    }
    guard let app = outermost else { return "the app you run the agent in" }
    // the first .app in the path is the one people know ("Orca.app/…/Orca Helper.app" → Orca)
    let first = app.components(separatedBy: "/").first(where: { $0.hasSuffix(".app") }) ?? app
    return (first as NSString).deletingPathExtension
}

// MARK: - Is anyone at the screen?

let lockedMessage = "The screen is locked, so apps show no windows and nobody can answer. Ask the person to unlock their Mac, then try again."

/// The login window is in front: the screen is locked, or another person's account is.
func screenLocked() -> Bool {
    if selfTest, let file = ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_PRETEND_LOCKED"], !file.isEmpty {
        return FileManager.default.fileExists(atPath: file)
    }
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true { return true }
    if (d[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue == false { return true }
    return false
}

// MARK: - Which apps

struct BlockRule {
    let ids: [String]
    let reason: String
}

let blockRules: [BlockRule] = [
    BlockRule(ids: ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable", "net.kovidgoyal.kitty",
                    "org.alacritty", "io.alacritty", "com.github.wez.wezterm", "co.zeit.hyper", "com.microsoft.VSCode", "com.microsoft.VSCodeInsiders",
                    "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "com.apple.dt.Xcode", "com.stablyai.orca", "com.openai.codex", "com.anthropic.claudefordesktop"],
              reason: "That app can run any command on this Mac, which is far more than one app. Agents run commands through their own tools, where you approve them."),
    BlockRule(ids: ["dev.schaefer.dispatch.ide", "dev.dispatch.ide"],
              reason: "An agent can't control Dispatch itself, so it can never approve its own requests."),
    BlockRule(ids: ["com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.1password",
                    "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.apple.SecurityAgent", "com.apple.Installer"],
              reason: "Agents never change system settings or open your passwords."),
]

func blockReason(bundleId: String?, name: String) -> String? {
    let id = bundleId ?? ""
    for rule in blockRules where rule.ids.contains(where: { $0.caseInsensitiveCompare(id) == .orderedSame }) {
        return rule.reason
    }
    if name.lowercased().contains("dispatch ide") { return blockRules[1].reason }
    return nil
}

func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != getpid() }
}

func findRunning(_ query: String) -> NSRunningApplication? {
    let q = query.lowercased()
    if q.hasPrefix("pid:"), let pid = Int32(q.dropFirst(4)), let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
        return app
    }
    let apps = regularApps()
    // the file name too: "Notes" finds 备忘录 on a Mac in Chinese
    let fileName = { (a: NSRunningApplication) -> String in a.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() ?? "" }
    return apps.first(where: { $0.bundleIdentifier?.lowercased() == q })
        ?? apps.first(where: { $0.localizedName?.lowercased() == q })
        ?? apps.first(where: { fileName($0) == q })
        ?? apps.first(where: { ($0.localizedName?.lowercased() ?? "").hasPrefix(q) })
}

func findInstalled(_ query: String) -> URL? {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) { return url }
    let fm = FileManager.default
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
        let url = URL(fileURLWithPath: dir).appendingPathComponent(query.hasSuffix(".app") ? query : query + ".app")
        if fm.fileExists(atPath: url.path) { return url }
        if let names = try? fm.contentsOfDirectory(atPath: dir),
           let hit = names.first(where: { $0.lowercased() == query.lowercased() + ".app" }) {
            return URL(fileURLWithPath: dir).appendingPathComponent(hit)
        }
    }
    return nil
}

// MARK: - Look: Dispatch's colors (DESIGN.md stone palette), light and dark

func dyn(_ light: UInt32, _ dark: UInt32, darkAlpha: CGFloat = 1) -> NSColor {
    func c(_ v: UInt32, _ a: CGFloat) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
    }
    return NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? c(dark, darkAlpha) : c(light, 1)
    }
}

enum Tok {
    static let bg = dyn(0xffffff, 0x0c0a09)
    static let bg2 = dyn(0xfafaf9, 0x1c1917)
    static let text = dyn(0x0c0a09, 0xfafaf9)
    static let text2 = dyn(0x79716b, 0xa6a09b)
    static let hair = dyn(0xe7e5e4, 0xffffff, darkAlpha: 0.10)
    static let chip = dyn(0xf2f1f0, 0x292524)
    static let fill = dyn(0x252525, 0xfafaf9)
    static let fillText = dyn(0xfafaf9, 0x0c0a09)
    static let green = dyn(0x3a9a6a, 0x4cb47f)
}

/// The agent's own mark: Claude and Codex from codicon, OpenCode from Dispatch's icon font, else the first letter.
func agentIcon(agent: String, fontPath: String?, char: String?, size: CGFloat) -> NSImage {
    var font: NSFont?
    if let path = fontPath, FileManager.default.fileExists(atPath: path),
       let descs = CTFontManagerCreateFontDescriptorsFromURL(URL(fileURLWithPath: path) as CFURL) as? [CTFontDescriptor], let d = descs.first {
        font = CTFontCreateWithFontDescriptor(d, size, nil) as NSFont
    }
    let glyph = (font != nil && char != nil && !char!.isEmpty) ? char! : String(agentName(agent).prefix(1))
    let f = font ?? NSFont.systemFont(ofSize: size * 0.62, weight: .semibold)
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        let attrs: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: Tok.text]
        let s = NSAttributedString(string: glyph, attributes: attrs)
        let b = s.size()
        s.draw(at: NSPoint(x: rect.midX - b.width / 2, y: rect.midY - b.height / 2))
        return true
    }
    return image
}

func agentName(_ agent: String) -> String {
    switch agent.lowercased() {
    case "claude", "claude-code": return "Claude"
    case "codex": return "Codex"
    case "opencode": return "OpenCode"
    case "", "agent": return "The agent"
    default: return agent.prefix(1).uppercased() + agent.dropFirst()
    }
}

class RoundedView: NSView {
    /// set it to hear the pointer come and go
    var onHover: ((Bool) -> Void)? { didSet { updateTrackingAreas() } }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        if onHover != nil {
            addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
        }
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
    var fillColor: NSColor = Tok.bg { didSet { needsDisplay = true } }
    var strokeColor: NSColor? = Tok.hair
    var radius: CGFloat = 16
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let r = radius >= bounds.height / 2 ? bounds.height / 2 : radius
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: r, yRadius: r)
        fillColor.setFill()
        path.fill()
        if let s = strokeColor {
            s.setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }
}

/// A capsule button in Dispatch's style: chip (secondary) or fill (the one primary per screen).
final class PillButton: NSButton {
    enum Kind { case chip, fill }
    let kind: Kind
    let keycap: String?
    var onPress: (() -> Void)?
    private(set) var width: CGFloat = 0
    static let titleFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    static let capFont = NSFont.systemFont(ofSize: 11, weight: .regular)

    init(_ title: String, kind: Kind, keycap: String? = nil, onPress: @escaping () -> Void) {
        self.kind = kind
        self.keycap = keycap
        self.onPress = onPress
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        wantsLayer = true
        bezelStyle = .regularSquare
        target = self
        action = #selector(pressed)
        setAccessibilityLabel(title)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 32).isActive = true
        var w = (title as NSString).size(withAttributes: [.font: PillButton.titleFont]).width
        if let cap = keycap { w += 6 + (cap as NSString).size(withAttributes: [.font: PillButton.capFont]).width + 10 }
        width = ceil(w) + 32
        widthAnchor.constraint(equalToConstant: width).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc func pressed() { onPress?() }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        (kind == .fill ? Tok.fill : Tok.chip).setFill()
        path.fill()
        let attrs: [NSAttributedString.Key: Any] = [.font: PillButton.titleFont, .foregroundColor: kind == .fill ? Tok.fillText : Tok.text]
        let s = NSAttributedString(string: title, attributes: attrs)
        let sz = s.size()
        // the key that does the same, as a key cap after the title ("Stop esc")
        var capText: NSAttributedString?
        var capW: CGFloat = 0
        if let cap = keycap {
            capText = NSAttributedString(string: cap, attributes: [.font: PillButton.capFont, .foregroundColor: Tok.text2])
            capW = capText!.size().width + 10
        }
        let total = sz.width + (capText == nil ? 0 : 6 + capW)
        let x = (bounds.width - total) / 2
        s.draw(at: NSPoint(x: x, y: (bounds.height - sz.height) / 2))
        if let c = capText {
            let capRect = NSRect(x: x + sz.width + 6, y: (bounds.height - 18) / 2, width: capW, height: 18)
            Tok.bg.setFill()
            NSBezierPath(roundedRect: capRect, xRadius: 4, yRadius: 4).fill()
            let cs = c.size()
            c.draw(at: NSPoint(x: capRect.midX - cs.width / 2, y: capRect.midY - cs.height / 2))
        }
    }
}

func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = Tok.text, wrap: Bool = false) -> NSTextField {
    let l = wrap ? NSTextField(wrappingLabelWithString: text) : NSTextField(labelWithString: text)
    l.font = NSFont.systemFont(ofSize: size, weight: weight)
    l.textColor = color
    l.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
    l.translatesAutoresizingMaskIntoConstraints = false
    return l
}

final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    var onEscape: (() -> Void)?
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// When the question went on screen: its buttons wait a moment before a click counts.
final class ShownClock {
    var shown: Date?
    // the self-test presses the buttons through `ui` right after the question shows: no wait there
    var settled: Bool { selfTest || (shown.map { Date().timeIntervalSince($0) >= AskWindow.settle } ?? false) }
}

/// The question window: one decision, the agent's icon, what and why, two buttons.
/// It answers only to a deliberate click: not in its first moment on screen (it can open right under a pointer that
/// is clicking something else), and its buttons take no keyboard focus (Space or Return typed into another app
/// a moment earlier presses nothing); Esc is Don't Allow. Always Allow sits on its own at the left, away from Allow.
final class AskWindow {
    let panel: KeyPanel
    private(set) var buttons: [PillButton] = []
    /// how long after it shows a click counts
    static let settle: TimeInterval = 0.8
    private let clock = ShownClock()

    init(icon: NSImage, title: String, why: String?, body: String, cancel: String, confirm: String, always: String? = nil, onCancel: @escaping () -> Void, onConfirm: @escaping () -> Void, onAlways: (() -> Void)? = nil) {
        panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.onEscape = onCancel

        let card = RoundedView()
        card.radius = 16
        card.fillColor = Tok.bg
        card.translatesAutoresizingMaskIntoConstraints = false

        let iconBox = RoundedView()
        iconBox.radius = 10
        iconBox.fillColor = Tok.chip
        iconBox.strokeColor = nil
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        let iconView = NSImageView(image: icon)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBox.addSubview(iconView)

        let titleLabel = label(title, size: 15, weight: .semibold)
        var texts: [NSView] = [titleLabel]
        if let why = why, !why.isEmpty {
            texts.append(label(why, size: 13, color: Tok.text, wrap: true))
        }
        texts.append(label(body, size: 12, color: Tok.text2, wrap: true))
        let textStack = NSStackView(views: texts)
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 8
        textStack.translatesAutoresizingMaskIntoConstraints = false

        let clock = self.clock
        let settled = { (run: @escaping () -> Void) -> () -> Void in { if clock.settled { run() } } }
        let cancelButton = PillButton(cancel, kind: .chip, onPress: settled(onCancel))
        let confirmButton = PillButton(confirm, kind: .fill, onPress: settled(onConfirm))
        buttons = [cancelButton, confirmButton]
        var rowViews: [NSView] = [cancelButton, confirmButton]
        // "Always Allow": this app from now on without asking (the CLI keeps the list, `dispatch computer allowed`)
        if let always = always, let onAlways = onAlways {
            let alwaysButton = PillButton(always, kind: .chip, onPress: settled(onAlways))
            buttons.insert(alwaysButton, at: 1)
            let gap = NSView()
            gap.translatesAutoresizingMaskIntoConstraints = false
            gap.setContentHuggingPriority(.defaultLow, for: .horizontal)
            rowViews = [alwaysButton, gap, cancelButton, confirmButton]
        }
        for b in buttons { b.refusesFirstResponder = true }
        let buttonRow = NSStackView(views: rowViews)
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.distribution = .fill
        buttonRow.translatesAutoresizingMaskIntoConstraints = false

        card.addSubview(iconBox)
        card.addSubview(textStack)
        card.addSubview(buttonRow)
        let content = NSView()
        content.addSubview(card)
        panel.contentView = content

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            card.topAnchor.constraint(equalTo: content.topAnchor),
            card.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            card.widthAnchor.constraint(equalToConstant: 440),
            iconBox.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            iconBox.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            iconBox.widthAnchor.constraint(equalToConstant: 36),
            iconBox.heightAnchor.constraint(equalToConstant: 36),
            iconView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 20),
            iconView.heightAnchor.constraint(equalToConstant: 20),
            textStack.leadingAnchor.constraint(equalTo: iconBox.trailingAnchor, constant: 16),
            textStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
            textStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            buttonRow.topAnchor.constraint(equalTo: textStack.bottomAnchor, constant: 24),
            buttonRow.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
            // with Always Allow the row runs from the text's left edge: it on the left, the answer on the right
            always != nil ? buttonRow.leadingAnchor.constraint(equalTo: textStack.leadingAnchor) : buttonRow.leadingAnchor.constraint(greaterThanOrEqualTo: textStack.leadingAnchor),
            buttonRow.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -24),
        ])
        content.layoutSubtreeIfNeeded()
        panel.setContentSize(content.fittingSize)
    }

    func show() {
        clock.shown = Date()
        if offscreen {
            panel.setFrameOrigin(NSPoint(x: -3000, y: 300))
            panel.orderFrontRegardless()
            return
        }
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.midY - size.height / 2 + f.height * 0.12))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func close() { panel.orderOut(nil) }
}

// MARK: - What the agent did: the steps of this session

/// One step: what the agent is doing or did, in plain words, when, and a picture of the app's window after it.
struct Step {
    let id: Int
    let at: Date
    var text: String
    var state: String  // now | done | failed
    var shot: String?
    var thumb: NSImage?
    /// it needed the app in front for a moment (keys, a real click, a drag)
    var front = false
}

/// The steps of one session, newest first, kept in its own folder (steps.json, one picture per step and
/// index.html, the same list as a page) so the person can look back at them after it ends.
final class StepLog {
    let dir: String
    var app: String
    let agent: String
    let started = Date()
    private(set) var steps: [Step] = []
    private var next = 0
    var ended: String?
    var picturesNote: String?
    var onChange: (() -> Void)?

    init(dir: String, app: String, agent: String) {
        self.dir = dir
        self.app = app
        self.agent = agent
        if !dir.isEmpty { try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }
    }

    @discardableResult
    func begin(_ text: String) -> Int {
        next += 1
        steps.insert(Step(id: next, at: Date(), text: text, state: "now"), at: 0)
        changed()
        return next
    }

    func end(_ id: Int, _ text: String, ok: Bool) {
        guard let i = steps.firstIndex(where: { $0.id == id }) else { return }
        steps[i].text = text
        steps[i].state = ok ? "done" : "failed"
        changed()
    }

    func markFront(_ id: Int) {
        guard let i = steps.firstIndex(where: { $0.id == id }) else { return }
        steps[i].front = true
        changed()
    }

    func attach(_ id: Int, shot: String) {
        guard let i = steps.firstIndex(where: { $0.id == id }) else { return }
        steps[i].shot = shot
        steps[i].thumb = NSImage(contentsOfFile: shot)
        changed()
    }

    var count: Int { steps.count }

    private func changed() {
        onChange?()
        save()
    }

    static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    func save() {
        guard !dir.isEmpty else { return }
        let rows: [[String: Any]] = steps.map { s in
            var o: [String: Any] = ["n": s.id, "at": s.at.timeIntervalSince1970, "text": s.text, "state": s.state, "front": s.front]
            if let p = s.shot { o["shot"] = (p as NSString).lastPathComponent }
            return o
        }
        var meta: [String: Any] = ["app": app, "agent": agent, "started": started.timeIntervalSince1970, "steps": rows]
        if let e = ended { meta["ended"] = e }
        try? jsonLine(meta).write(toFile: dir + "/steps.json", atomically: true, encoding: .utf8)
        try? page().write(toFile: dir + "/index.html", atomically: true, encoding: .utf8)
    }

    static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// The same list as the bar's, as a page that stands on its own (pictures inline).
    func page() -> String {
        let who = agentName(agent)
        let last = steps.first?.at ?? started
        let span = "\(StepLog.clock.string(from: started).prefix(5))–\(StepLog.clock.string(from: last).prefix(5))"
        var rows = ""
        let anyPicture = steps.contains { $0.shot != nil }
        for s in steps {
            var pic = anyPicture ? "<div class=\"pic none\"></div>" : ""
            if let p = s.shot, let data = FileManager.default.contents(atPath: p) {
                pic = "<a class=\"pic\" href=\"\(StepLog.esc((p as NSString).lastPathComponent))\"><img alt=\"\" src=\"data:image/jpeg;base64,\(data.base64EncodedString())\"></a>"
            }
            let cls = s.state == "failed" ? " failed" : (s.state == "now" ? " now" : "")
            rows += "<li class=\"step\(cls)\">\(pic)<div class=\"txt\"><div class=\"what\">\(StepLog.esc(s.text))</div><div class=\"when\">\(StepLog.clock.string(from: s.at))\(s.front ? " · \(StepLog.esc(app)) in front for a moment" : "")</div></div></li>\n"
        }
        let state = ended.map { StepLog.esc($0) } ?? "Still working"
        let note = picturesNote.map { "<p class=\"note\">\(StepLog.esc($0))</p>" } ?? ""
        return """
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(StepLog.esc(who)) used \(StepLog.esc(app))</title>
        <style>
        :root{--bg:#fff;--bg2:#fafaf9;--text:#0c0a09;--text2:#79716b;--hair:#e7e5e4;--chip:#f2f1f0;--green:#3a9a6a;--red:#c2410c}
        @media (prefers-color-scheme: dark){:root{--bg:#0c0a09;--bg2:#1c1917;--text:#fafaf9;--text2:#a6a09b;--hair:rgba(255,255,255,.1);--chip:#292524;--green:#4cb47f;--red:#fb923c}}
        body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
        main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
        h1{font-size:20px;font-weight:600;margin:0 0 4px}
        .sub{color:var(--text2);font-size:13px;margin:0 0 24px}
        ol{list-style:none;margin:0;padding:0;border:1px solid var(--hair);border-radius:16px;overflow:hidden;background:var(--bg2)}
        .step{display:flex;gap:16px;align-items:center;padding:12px 16px;border-top:1px solid var(--hair)}
        .step:first-child{border-top:0}
        .pic{flex:none;width:160px;height:100px;border-radius:8px;overflow:hidden;background:var(--chip);display:block}
        .pic img{width:100%;height:100%;object-fit:cover;object-position:top left;display:block}
        .what{font-size:14px}
        .when{font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums}
        .now .what::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:8px;vertical-align:1px}
        .failed .what{color:var(--text2)}
        .failed .what::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--red);margin-right:8px;vertical-align:2px}
        .text-only .step{padding:8px 16px}
        .note{color:var(--text2);font-size:13px;margin:16px 0 0}
        @media (max-width:520px){.pic{width:96px;height:60px}}
        </style></head>
        <body><main>
        <h1>\(StepLog.esc(who)) used \(StepLog.esc(app))</h1>
        <p class="sub">\(steps.count) step\(steps.count == 1 ? "" : "s") · \(span) · \(state)</p>
        <ol class="\(anyPicture ? "" : "text-only")">
        \(rows)</ol>
        \(note)
        </main></body></html>
        """
    }
}

/// Picture of the app's front window after a step, small enough to keep (JPEG, 640 points wide at most).
func windowShot(pid: pid_t, to path: String) -> Bool {
    guard CGPreflightScreenCaptureAccess() else { return false }
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let win = infos.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
          let wid = win[kCGWindowNumber as String] as? Int else { return false }
    let raw = path + ".png"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l\(wid)", raw]
    do { try p.run() } catch { return false }
    p.waitUntilExit()
    defer { try? FileManager.default.removeItem(atPath: raw) }
    guard let img = NSImage(contentsOfFile: raw), let rep = img.representations.first else { return false }
    let w = CGFloat(rep.pixelsWide), h = CGFloat(rep.pixelsHigh)
    guard w > 0, h > 0 else { return false }
    let scale = min(1, 1280 / w)
    let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w * scale), pixelsHigh: Int(h * scale), bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    guard let o = out else { return false }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: o)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: w * scale, height: h * scale).fill()
    rep.draw(in: NSRect(x: 0, y: 0, width: w * scale, height: h * scale))
    NSGraphicsContext.restoreGraphicsState()
    guard let jpg = o.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { return false }
    return (try? jpg.write(to: URL(fileURLWithPath: path))) != nil
}

/// The bar's pill: a click opens the list of steps under it.
final class PressableView: RoundedView {
    var onPress: (() -> Void)?
    var label = "Pin steps"
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onPress?() }
    }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { label }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

/// A flipped container, so rows lay out top-down.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// The list under the bar: every step of this session, the newest on top, each with a small picture.
/// The app's window, live: one window of one app (ScreenCaptureKit, not the whole screen), shown only
/// while the list is open, never saved. A ring marks where the last step clicked or dropped.
final class LiveView: NSView, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var windowID: CGWindowID = 0
    private(set) var windowFrame: CGRect = .zero
    private let frameLayer = CALayer()
    private let ring = CAShapeLayer()
    private let queue = DispatchQueue(label: "dispatch.computer.live")
    private var mark: CGPoint?
    private var starting = false
    /// height over width of the window being shown
    private(set) var aspect: CGFloat = 0.625
    var onAspect: (() -> Void)?
    private(set) var frames = 0
    /// a frame of the stream is on screen (until then, or once it stops, the last step's picture stands in)
    private var hasLive = false
    /// the picture of the newest step that has one: shown while there is no live frame, so the box is never empty
    var still: NSImage? {
        didSet { if !hasLive { frameLayer.contents = still } }
    }
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true
        layer?.backgroundColor = Tok.chip.cgColor
        frameLayer.contentsGravity = .resizeAspect
        layer?.addSublayer(frameLayer)
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = Tok.green.cgColor
        ring.lineWidth = 2.5
        ring.opacity = 0
        layer?.addSublayer(ring)
    }

    required init?(coder: NSCoder) { fatalError() }

    var isLive: Bool { stream != nil }

    /// Show this app's window (the one at `prefer`, else its biggest), or keep showing it.
    func start(pid: pid_t, prefer: CGRect?) {
        // self-test: a still picture stands in for the stream, to picture the layout on a Mac without the permission
        if selfTest, let still = ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_LIVE_STILL"], let img = NSImage(contentsOfFile: still) {
            windowFrame = prefer ?? CGRect(x: 0, y: 0, width: img.size.width, height: img.size.height)
            aspect = max(0.3, min(1.6, windowFrame.height / max(windowFrame.width, 1)))
            frameLayer.contents = img
            onAspect?()
            return
        }
        guard pid != 0, CGPreflightScreenCaptureAccess(), !starting else { return }
        starting = true
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, _ in
            let mine = (content?.windows ?? []).filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 40 && $0.frame.height > 40 }
            let near = prefer.flatMap { f in mine.first { abs($0.frame.minX - f.minX) < 6 && abs($0.frame.minY - f.minY) < 6 } }
            let pick = near ?? mine.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.starting = false
                if let w = pick { self.show(w) }
            }
        }
    }

    private func show(_ w: SCWindow) {
        if stream != nil && w.windowID == windowID { windowFrame = w.frame; return }
        stop()
        windowID = w.windowID
        windowFrame = w.frame
        aspect = max(0.3, min(1.6, w.frame.height / max(w.frame.width, 1)))
        onAspect?()
        let config = SCStreamConfiguration()
        let scale: CGFloat = 2
        config.width = Int(min(w.frame.width * scale, 1600))
        config.height = Int(CGFloat(config.width) * aspect)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 12)
        config.queueDepth = 4
        config.showsCursor = true
        let s = SCStream(filter: SCContentFilter(desktopIndependentWindow: w), configuration: config, delegate: self)
        do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue) } catch { return }
        stream = s
        s.startCapture { [weak self] error in
            if error != nil { DispatchQueue.main.async { self?.stream = nil; self?.hasLive = false; self?.frameLayer.contents = self?.still } }
        }
    }

    func stop() {
        stream?.stopCapture(completionHandler: nil)
        stream = nil
        windowID = 0
        hasLive = false
        frameLayer.contents = still
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        // only whole frames (an idle window sends "nothing changed" frames without a picture)
        if let info = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = info.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        guard let surface = CVPixelBufferGetIOSurface(pb)?.takeUnretainedValue() else { return }
        DispatchQueue.main.async {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self.frameLayer.contents = surface
            CATransaction.commit()
            self.hasLive = true
            self.frames += 1
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async {
            guard self.stream === stream else { return }
            self.stream = nil
            self.hasLive = false
            self.frameLayer.contents = self.still
        }
    }

    /// Where the window's picture sits in this view.
    private var pictureRect: CGRect {
        let b = bounds
        guard b.width > 0, b.height > 0 else { return .zero }
        let w = min(b.width, b.height / aspect)
        let h = w * aspect
        return CGRect(x: (b.width - w) / 2, y: (b.height - h) / 2, width: w, height: h)
    }

    /// A ring where the step clicked (a point on the screen), fading out after a moment.
    func markPoint(_ p: CGPoint) {
        guard windowFrame.width > 0, windowFrame.contains(p) else { return }
        mark = p
        placeRing()
        ring.removeAllAnimations()
        ring.opacity = 1
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = CACurrentMediaTime() + 1.6
        fade.duration = 0.6
        fade.fillMode = .forwards
        fade.isRemovedOnCompletion = false
        ring.add(fade, forKey: "fade")
    }

    private func placeRing() {
        guard let p = mark, windowFrame.width > 0 else { return }
        let r = pictureRect
        let x = r.minX + (p.x - windowFrame.minX) / windowFrame.width * r.width
        let y = r.minY + (p.y - windowFrame.minY) / windowFrame.height * r.height
        ring.path = CGPath(ellipseIn: CGRect(x: x - 9, y: y - 9, width: 18, height: 18), transform: nil)
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        frameLayer.frame = bounds
        ring.frame = bounds
        placeRing()
        CATransaction.commit()
    }
}

final class StepsPanel {
    let panel: NSPanel
    private let card = RoundedView()
    private let scroll = NSScrollView()
    private let list = FlippedView()
    private let header: NSTextField
    private let note: NSTextField
    private let noteButton: PillButton
    var onHover: ((Bool) -> Void)?
    static let width: CGFloat = 440
    static let rowHeight: CGFloat = 64
    static let maxListHeight: CGFloat = 264
    static let maxLiveHeight: CGFloat = 300
    let live = LiveView(frame: .zero)
    private let noteBox = RoundedView()

    init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: StepsPanel.width, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        card.radius = 16
        card.fillColor = Tok.bg
        header = label("", size: 12, weight: .semibold, color: Tok.text2)
        note = label("", size: 12, color: Tok.text2, wrap: true)
        noteButton = PillButton("Allow Screen Recording", kind: .chip) {
            // macOS asks once and puts the app in the list; the page in System Settings is where it is turned on
            _ = CGRequestScreenCaptureAccess()
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
        }
        noteButton.translatesAutoresizingMaskIntoConstraints = true
        header.translatesAutoresizingMaskIntoConstraints = true
        note.translatesAutoresizingMaskIntoConstraints = true
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = list
        noteBox.radius = 8
        noteBox.fillColor = Tok.bg2
        noteBox.strokeColor = Tok.hair
        card.addSubview(noteBox)
        card.addSubview(live)
        card.addSubview(header)
        card.addSubview(scroll)
        card.addSubview(note)
        card.addSubview(noteButton)
        panel.contentView = card
        card.onHover = { [weak self] inside in self?.onHover?(inside) }
    }

    func render(_ log: StepLog) {
        let w = StepsPanel.width
        let pad: CGFloat = 16
        for v in list.subviews { v.removeFromSuperview() }
        // the steps, one line each (the window is shown live above; the saved page keeps a picture per step):
        // [dot 8 while it happens] what … [in front mark] [time 11, right]
        var y: CGFloat = 0
        let rowH: CGFloat = 32
        let timeW: CGFloat = 60
        for s in log.steps {
            let row = FlippedView(frame: NSRect(x: 0, y: y, width: w, height: rowH))
            var x = pad
            if s.state == "now" {
                let dot = RoundedView()
                dot.radius = 999
                dot.fillColor = Tok.green
                dot.strokeColor = nil
                dot.frame = NSRect(x: x, y: 12, width: 8, height: 8)
                row.addSubview(dot)
                x += 16
            }
            let when = label(StepLog.clock.string(from: s.at), size: 11, color: Tok.text2)
            when.translatesAutoresizingMaskIntoConstraints = true
            when.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            when.alignment = .right
            when.frame = NSRect(x: w - pad - timeW, y: 8, width: timeW, height: 16)
            row.addSubview(when)
            let what = NSTextField(labelWithAttributedString: {
                let t = NSMutableAttributedString(string: s.text, attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: s.state == "failed" ? Tok.text2 : Tok.text])
                if s.front { t.append(NSAttributedString(string: "  · in front for a moment", attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: Tok.text2])) }
                return t
            }())
            what.lineBreakMode = .byTruncatingTail
            what.toolTip = s.text + (s.front ? " (\(log.app) was brought to the front for a moment)" : "")
            what.frame = NSRect(x: x, y: 7, width: w - x - pad - timeW - 8, height: 18)
            row.addSubview(what)
            list.addSubview(row)
            y += rowH
        }
        list.frame = NSRect(x: 0, y: 0, width: w, height: max(y, 1))
        live.still = log.steps.first(where: { $0.thumb != nil })?.thumb
        let listH = min(max(y, rowH), StepsPanel.maxListHeight)
        header.stringValue = "\(log.count) step\(log.count == 1 ? "" : "s") · newest first"
        // on top: the window live, or why it can't be shown
        var top: CGFloat = 12
        let canSee = log.picturesNote == nil
        live.isHidden = !canSee
        noteBox.isHidden = canSee
        note.isHidden = canSee
        noteButton.isHidden = canSee
        if canSee {
            let lw = w - 2 * pad
            let lh = min(ceil(lw * live.aspect), StepsPanel.maxLiveHeight)
            live.frame = NSRect(x: pad, y: top, width: lw, height: lh)
            top += lh + 12
        } else if let n = log.picturesNote {
            note.stringValue = n
            note.preferredMaxLayoutWidth = w - 2 * pad - 24
            let nh = ceil(note.fittingSize.height)
            noteBox.frame = NSRect(x: pad, y: top, width: w - 2 * pad, height: 10 + nh + 8 + 32 + 10)
            note.frame = NSRect(x: pad + 12, y: top + 10, width: w - 2 * pad - 24, height: nh)
            noteButton.frame = NSRect(x: pad + 12, y: top + 10 + nh + 8, width: noteButton.width, height: 32)
            top += noteBox.frame.height + 16
        }
        header.frame = NSRect(x: pad, y: top, width: w - 2 * pad, height: 18)
        scroll.frame = NSRect(x: 0, y: top + 22, width: w, height: listH)
        card.frame = NSRect(x: 0, y: 0, width: w, height: top + 22 + listH + 8)
        list.scroll(.zero)
    }

    var height: CGFloat { card.frame.height }
}

/// The bar at the top of the screen while an agent works: who, which app, the last step, Stop.
/// A click on it opens the list of every step so far.
final class WorkingBar {
    let panel: NSPanel
    private let stepLabel: NSTextField
    private let titleLabel: NSTextField
    let stopButton: PillButton
    private let dot: RoundedView
    private let pill = PressableView()
    private let chevron = NSImageView()
    let steps = StepsPanel()
    /// open while the pointer is over the bar or the list; a click keeps it open (pinned)
    private(set) var expanded = false
    private(set) var pinned = false
    private var overBar = false, overList = false
    var log: StepLog?
    /// which app's window to show live, and where its front window is (to pick that one)
    var liveSource: (() -> (pid_t, CGRect?))?

    init(icon: NSImage, title: String, onStop: @escaping () -> Void) {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 44), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        pill.radius = 999
        pill.fillColor = Tok.bg2
        pill.translatesAutoresizingMaskIntoConstraints = false

        let iconView = NSImageView(image: icon)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        dot = RoundedView()
        dot.radius = 999
        dot.fillColor = Tok.green
        dot.strokeColor = nil
        dot.translatesAutoresizingMaskIntoConstraints = false
        titleLabel = label(title, size: 13, weight: .medium)
        stepLabel = label("", size: 12, color: Tok.text2)
        stepLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
        chevron.contentTintColor = Tok.text2
        chevron.translatesAutoresizingMaskIntoConstraints = false
        stopButton = PillButton("Stop", kind: .chip, keycap: "esc", onPress: onStop)

        for v in [iconView, dot, titleLabel, stepLabel, chevron, stopButton] as [NSView] { pill.addSubview(v) }
        let content = NSView()
        content.addSubview(pill)
        panel.contentView = content
        NSLayoutConstraint.activate([
            pill.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            pill.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            pill.topAnchor.constraint(equalTo: content.topAnchor),
            pill.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            pill.heightAnchor.constraint(equalToConstant: 48),
            pill.widthAnchor.constraint(lessThanOrEqualToConstant: 640),
            pill.widthAnchor.constraint(greaterThanOrEqualToConstant: 360),
            iconView.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
            iconView.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 16),
            dot.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 8),
            dot.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            titleLabel.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
            titleLabel.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            stepLabel.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 8),
            stepLabel.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            chevron.leadingAnchor.constraint(equalTo: stepLabel.trailingAnchor, constant: 8),
            chevron.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            chevron.widthAnchor.constraint(equalToConstant: 12),
            chevron.heightAnchor.constraint(equalToConstant: 12),
            stopButton.leadingAnchor.constraint(greaterThanOrEqualTo: chevron.trailingAnchor, constant: 12),
            stopButton.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -8),
            stopButton.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])
        pill.onPress = { [weak self] in self?.toggle() }
        steps.live.onAspect = { [weak self] in self?.refresh() }
        pill.onHover = { [weak self] inside in self?.hover(bar: inside) }
        steps.onHover = { [weak self] inside in self?.hover(list: inside) }
        step("Starting")
    }

    func step(_ text: String) {
        stepLabel.stringValue = text
        relayout()
    }

    /// The list changed: the bar shows the newest step, an open list redraws.
    func refresh() {
        guard let log = log else { return }
        if let top = log.steps.first { stepLabel.stringValue = top.text }
        relayout()
    }

    func setTitle(_ text: String) {
        titleLabel.stringValue = text
        relayout()
    }

    /// Something to say right now, before the step is done (it draws at once).
    func note(_ text: String) {
        stepLabel.stringValue = text
        relayout()
        panel.display()
    }

    private var watch: Timer?
    private var awayTicks = 0

    func hover(bar: Bool? = nil, list: Bool? = nil) {
        if let b = bar { overBar = b }
        if let l = list { overList = l }
        if (overBar || overList) && !expanded { setExpanded(true) }
    }

    /// While the list is open on hover, follow the pointer: it closes a moment after the pointer has
    /// left both the bar and the list (exit events alone get lost when windows change under the pointer).
    private func followPointer() {
        watch?.invalidate()
        awayTicks = 0
        watch = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            guard self.expanded, !self.pinned else { t.invalidate(); self.watch = nil; return }
            let p = NSEvent.mouseLocation
            var area = self.panel.frame.insetBy(dx: -4, dy: -4)
            if self.steps.panel.isVisible { area = area.union(self.steps.panel.frame.insetBy(dx: -4, dy: -4)) }
            if area.contains(p) { self.awayTicks = 0; return }
            self.awayTicks += 1
            if self.awayTicks >= 2 {
                self.overBar = false
                self.overList = false
                self.setExpanded(false)
            }
        }
    }

    /// A click: keep the list open (or let it go again).
    func toggle() {
        pinned.toggle()
        setExpanded(pinned || overBar || overList)
    }

    func setExpanded(_ on: Bool) {
        expanded = on
        if on && !pinned { followPointer() }
        if on, let src = liveSource?() { steps.live.start(pid: src.0, prefer: src.1) } else if !on { steps.live.stop() }
        pill.label = pinned ? "Unpin steps" : "Pin steps"
        chevron.image = NSImage(systemSymbolName: expanded ? "chevron.up" : "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
        relayout()
    }

    /// After a step: the live view follows the app's front window and rings where the step pointed.
    func stepped(at point: CGPoint?) {
        guard expanded, let src = liveSource?() else { return }
        steps.live.start(pid: src.0, prefer: src.1)
        if let p = point { steps.live.markPoint(p) }
    }

    func finish(_ text: String) {
        steps.live.stop()
        dot.fillColor = Tok.text2
        titleLabel.stringValue = text
        stepLabel.stringValue = ""
        stopButton.isHidden = true
        chevron.isHidden = true
        pinned = false
        overBar = false
        overList = false
        if expanded { setExpanded(false) }
        relayout()
    }

    private func relayout() {
        guard let content = panel.contentView else { return }
        content.layoutSubtreeIfNeeded()
        let size = content.fittingSize
        var barFrame = NSRect(x: -3000, y: 100, width: size.width, height: size.height)
        if !offscreen, let screen = NSScreen.main {
            let f = screen.visibleFrame
            barFrame = NSRect(x: f.midX - size.width / 2, y: f.maxY - size.height - 12, width: size.width, height: size.height)
        }
        panel.setFrame(barFrame, display: true)
        if expanded, let log = log {
            steps.render(log)
            let h = steps.height
            steps.panel.setFrame(NSRect(x: barFrame.midX - StepsPanel.width / 2, y: barFrame.minY - 8 - h, width: StepsPanel.width, height: h), display: true)
            if panel.isVisible { steps.panel.orderFrontRegardless() }
        } else {
            steps.panel.orderOut(nil)
        }
    }

    func show() { relayout(); panel.orderFrontRegardless() }

    func close() {
        steps.panel.orderOut(nil)
        panel.orderOut(nil)
    }
}

// MARK: - The practice app (self-test only)

final class PracticeNotes: NSObject, NSTextFieldDelegate {
    let window: NSWindow
    let field = NSTextField(string: "")
    let saved = NSTextField(labelWithString: "Nothing saved yet")
    let out: String

    init(out: String) {
        self.out = out
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        window.title = practiceAppName
        field.placeholderString = "Note"
        field.setAccessibilityLabel("Note")
        let save = NSButton(title: "Save", target: self, action: #selector(doSave))
        let stack = NSStackView(views: [field, save, saved])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        field.widthAnchor.constraint(equalToConstant: 300).isActive = true
        field.delegate = self
        window.contentView = stack
        // off screen: nobody sees it, the Accessibility tree is the same
        window.setFrameOrigin(NSPoint(x: -3000, y: 200))
        window.orderFrontRegardless()
    }

    @objc func doSave() {
        saved.stringValue = "Saved: " + field.stringValue
        report()
    }

    func controlTextDidChange(_ obj: Notification) { report() }

    func report() {
        writeState(out, ["field": field.stringValue, "saved": saved.stringValue])
    }
}

// MARK: - Accessibility reading and acting

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String {
    guard let v = axAttr(el, name) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

let roleNames: [String: String] = [
    "AXButton": "button", "AXTextField": "text field", "AXTextArea": "text area", "AXStaticText": "text", "AXCheckBox": "checkbox",
    "AXRadioButton": "radio button", "AXPopUpButton": "pop-up menu", "AXMenuButton": "menu button", "AXLink": "link", "AXImage": "image",
    "AXRow": "row", "AXCell": "cell", "AXTabGroup": "tabs", "AXToolbar": "toolbar", "AXWindow": "window", "AXSlider": "slider",
    "AXComboBox": "combo box", "AXMenuItem": "menu item", "AXList": "list", "AXTable": "table", "AXOutline": "outline",
    "AXWebArea": "web page", "AXHeading": "heading", "AXDisclosureTriangle": "disclosure", "AXIncrementor": "stepper",
    "AXSegmentedControl": "segments", "AXColorWell": "color", "AXDateField": "date field", "AXSheet": "sheet", "AXDialog": "dialog",
]
let actionable: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink",
                               "AXSlider", "AXComboBox", "AXMenuItem", "AXRow", "AXCell", "AXDisclosureTriangle", "AXIncrementor", "AXDateField", "AXColorWell"]
let skipped: Set<String> = ["AXScrollBar", "AXValueIndicator", "AXGrowArea", "AXSplitter", "AXUnknown", "AXLayoutItem"]

/// Where an element is on the screen (top-left origin, the space mouse events use).
func frame(_ el: AXUIElement) -> CGRect? {
    guard let pv = axAttr(el, kAXPositionAttribute), let sv = axAttr(el, kAXSizeAttribute),
          CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    var pos = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sv as! AXValue, .cgSize, &size)
    return CGRect(origin: pos, size: size)
}

final class Snapshot {
    var lines: [String] = []
    var elements: [Int: AXUIElement] = [:]
    var labels: [Int: String] = [:]
    var count = 0
    let limit = 700
    /// with frames: where each part is, from this corner (the first window's)
    var origin: CGPoint?
    /// the one part the keyboard goes to
    var focused: AXUIElement?
    private var seen: [AXUIElement] = []

    func walk(_ el: AXUIElement, depth: Int) {
        if count >= limit || depth > 40 { return }
        // some apps list an element (even the app itself) among its own descendants: never twice
        if seen.contains(where: { CFEqual($0, el) }) { return }
        seen.append(el)
        let role = axString(el, kAXRoleAttribute)
        if skipped.contains(role) || role == "AXApplication" { return }
        let subrole = axString(el, kAXSubroleAttribute)
        var name = axString(el, kAXTitleAttribute)
        if name.isEmpty { name = axString(el, kAXDescriptionAttribute) }
        if name.isEmpty { name = axString(el, "AXPlaceholderValue") }
        var value = role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || role == "AXCheckBox" || role == "AXSlider"
            ? axString(el, kAXValueAttribute) : ""
        if role == "AXStaticText" && name.isEmpty { name = value; value = "" }
        let keep = actionable.contains(role) || !name.isEmpty || role == "AXWindow" || role == "AXSheet" || role == "AXWebArea" || role == "AXHeading"
        var childDepth = depth
        if keep {
            count += 1
            let i = count
            elements[i] = el
            var roleName = roleNames[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased()
            if subrole == "AXSearchField" { roleName = "search field" }
            if subrole == "AXSecureTextField" { roleName = "password field"; value = value.isEmpty ? "" : "••••" }
            var line = String(repeating: "  ", count: depth) + "[\(i)] \(roleName)"
            if !name.isEmpty { line += " \"\(short(name))\"" }
            if !value.isEmpty { line += " = \"\(short(value, 120))\"" }
            if let enabled = axAttr(el, kAXEnabledAttribute) as? Bool, !enabled { line += " (disabled)" }
            if let f = focused, CFEqual(f, el) { line += " (focused)" }
            if let o = origin, let f = frame(el), f.width > 0 || f.height > 0 {
                line += " @\(Int((f.minX - o.x).rounded())),\(Int((f.minY - o.y).rounded())) \(Int(f.width.rounded()))x\(Int(f.height.rounded()))"
            }
            lines.append(line)
            labels[i] = !name.isEmpty ? name : (!value.isEmpty && !roleName.hasPrefix("password") ? short(value, 60) : roleName)
            childDepth = depth + 1
        }
        guard var children = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
        // a long table (every note, every file) would use up the list: only the rows on screen
        if role == "AXTable" || role == "AXOutline" || role == "AXList", children.count > 60 {
            let rows = children.filter { axString($0, kAXRoleAttribute) == "AXRow" }
            if let visible = axAttr(el, kAXVisibleRowsAttribute) as? [AXUIElement], !visible.isEmpty, rows.count > visible.count {
                children = children.filter { axString($0, kAXRoleAttribute) != "AXRow" } + visible
                let note = String(repeating: "  ", count: childDepth) + "(\(rows.count - visible.count) more rows out of sight: scroll to see them)"
                if lines.last != note { lines.append(note) }
            } else if children.count > 200 {
                lines.append(String(repeating: "  ", count: childDepth) + "(\(children.count - 200) more items after these: scroll to see them)")
                children = Array(children.prefix(200))
            }
        }
        for c in children { walk(c, depth: childDepth) }
    }
}

// MARK: - Keys

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "backspace": 51, "delete": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "pageup": 116, "forwarddelete": 117,
    "end": 119, "pagedown": 121, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
]

func parseKey(_ spec: String) -> (CGKeyCode, CGEventFlags)? {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for part in spec.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch part {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default:
            guard let k = keyCodes[part] else { return nil }
            key = k
        }
    }
    guard let k = key else { return nil }
    return (k, flags)
}

// MARK: - The session

final class Session: NSObject {
    let socketPath: String
    let statePath: String
    let query: String
    let agent: String
    let why: String
    let icon: NSImage
    let smallIcon: NSImage
    let idleSeconds: TimeInterval

    var target: NSRunningApplication?
    var targetName = ""
    var targetPid: pid_t = 0
    var ask: AskWindow?
    var bar: WorkingBar?
    var snapshot: Snapshot?
    var listenFd: Int32 = -1
    var lastCommand = Date()
    var finished = false
    var monitors: [Any] = []
    var log: StepLog?
    let runDir: String
    let onEnd: [String]
    var ranOnEnd = false
    var previousFront: NSRunningApplication?
    /// the person allowed this app before for good (`--preapproved`), or does it now (Always Allow)
    let preapproved: Bool
    var alwaysAllowed = false

    init(args: [String]) {
        preapproved = args.contains("--preapproved")
        socketPath = argValue(args, "--socket") ?? ""
        statePath = argValue(args, "--state") ?? ""
        query = argValue(args, "--app") ?? ""
        agent = argValue(args, "--agent") ?? "agent"
        why = argValue(args, "--why") ?? ""
        idleSeconds = TimeInterval(argValue(args, "--idle") ?? "") ?? 600
        runDir = argValue(args, "--run-dir") ?? ""
        // a command to run when the session ends (the CLI files the steps with the conversation)
        onEnd = (argValue(args, "--on-end").flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String]) ?? []
        icon = agentIcon(agent: agent, fontPath: argValue(args, "--icon-font"), char: argValue(args, "--icon-char"), size: 20)
        smallIcon = agentIcon(agent: agent, fontPath: argValue(args, "--icon-font"), char: argValue(args, "--icon-char"), size: 16)
        super.init()
    }

    func state(_ status: String, _ extra: [String: Any] = [:]) {
        var o: [String: Any] = ["status": status, "app": targetName.isEmpty ? query : targetName, "query": query, "agent": agent, "socket": socketPath]
        for (k, v) in extra { o[k] = v }
        writeState(statePath, o)
    }

    func start() {
        // 1. which app
        var installedURL: URL?
        var bundleId: String?
        if let running = findRunning(query) {
            target = running
            targetName = running.localizedName ?? query
            if selfTest && targetName.hasPrefix("dispatch-computer") { targetName = practiceAppName }
            bundleId = running.bundleIdentifier
        } else if let url = findInstalled(query) {
            installedURL = url
            // the name people see in the Dock and Finder (备忘录 for Notes on a Mac in Chinese)
            targetName = (FileManager.default.displayName(atPath: url.path) as NSString).deletingPathExtension
            bundleId = Bundle(url: url)?.bundleIdentifier
        } else {
            state("not-found", ["message": "There is no app called \(query) on this Mac. `dispatch computer apps` lists the open ones."])
            exit(0)
        }
        if let reason = blockReason(bundleId: bundleId, name: targetName) {
            state("refused", ["message": "\(targetName): \(reason)"])
            exit(0)
        }
        // nobody can see the question, and the app would show no windows
        if screenLocked() {
            state("screen-locked", ["message": lockedMessage])
            exit(0)
        }
        // 2. may this Mac's app (the one the agent runs in) use other apps at all?
        // self-test: DISPATCH_COMPUTER_PRETEND_UNTRUSTED=1 shows the permission window on a Mac that has it
        if !AXIsProcessTrusted() || (selfTest && ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_PRETEND_UNTRUSTED"] == "1") {
            let host = hostAppName()
            state("needs-permission", ["host": host, "message": "macOS has not allowed \(host) to use other apps yet. The person sees a window explaining how to turn on Accessibility for \(host); ask them, then try again."])
            ask = AskWindow(
                icon: icon,
                title: "Let agents use other apps?",
                why: "\(agentName(agent)) wants to use \(targetName)" + (why.isEmpty ? "." : " to \(why)."),
                body: "To click and type in other apps for you, macOS needs your OK once: turn on \(host) in System Settings > Privacy & Security > Accessibility. Agents still ask you before they use any app, and you can stop them at any time.",
                cancel: "Not Now",
                confirm: "Open Settings",
                onCancel: { [weak self] in self?.end("needs-permission", keepState: true) },
                onConfirm: { [weak self] in
                    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(opts)
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                        NSWorkspace.shared.open(url)
                    }
                    self?.end("needs-permission", keepState: true)
                })
            if previousFront == nil { previousFront = NSWorkspace.shared.frontmostApplication }
        ask?.show()
            DispatchQueue.main.asyncAfter(deadline: .now() + 300) { [weak self] in self?.end("needs-permission", keepState: true) }
            if selfTest { listen() }
            return
        }
        // 3. ask the person, unless they allowed this app for good before
        if preapproved {
            allowed(installedURL)
            return
        }
        state("asking")
        ask = AskWindow(
            icon: icon,
            title: "\(agentName(agent)) wants to use \(targetName)",
            why: why.isEmpty ? nil : "To \(why)",
            body: "It can click and type in \(targetName) only. A bar at the top of your screen shows each step; click Stop there or press Esc to take back control.",
            cancel: "Don't Allow",
            confirm: "Allow",
            always: "Always Allow",
            onCancel: { [weak self] in self?.denied() },
            onConfirm: { [weak self] in self?.allowed(installedURL) },
            onAlways: { [weak self] in self?.alwaysAllowed = true; self?.allowed(installedURL) })
        if previousFront == nil { previousFront = NSWorkspace.shared.frontmostApplication }
        ask?.show()
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { [weak self] in
            guard let self = self, self.bar == nil, !self.finished else { return }
            self.state("denied", ["message": "Nobody answered in 5 minutes."])
            self.end(nil)
        }
        // the screen locks while the question is up: say so now instead of waiting five minutes
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
            guard let self = self, self.bar == nil, !self.finished else { t.invalidate(); return }
            if screenLocked() {
                t.invalidate()
                self.state("screen-locked", ["message": lockedMessage])
                self.end(nil)
            }
        }
        // the socket is up already so `ui` (self-test) can press the question's buttons
        if selfTest { listen() }
    }

    func denied() {
        state("denied", ["message": "The person said no. Do not ask again for this; tell them what you wanted to do and let them do it, or ask what to do instead."])
        giveFocusBack()
        end(nil)
    }

    /// The question took the keyboard: it goes back to the app the person was in.
    func giveFocusBack() {
        if let p = previousFront, p.processIdentifier != getpid(), !p.isTerminated { p.activate() }
    }

    func allowed(_ installedURL: URL?) {
        ask?.close()
        ask = nil
        giveFocusBack()
        if let p = previousFront, p.processIdentifier != getpid() { personApp = p }
        if let running = target {
            targetPid = running.processIdentifier
        } else if let url = installedURL {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false  // it opens behind the app the person is in
            NSWorkspace.shared.openApplication(at: url, configuration: config) { app, _ in
                DispatchQueue.main.async {
                    self.target = app
                    self.targetPid = app?.processIdentifier ?? 0
                    // the name the person knows it by (备忘录 for Notes on a Mac in Chinese)
                    if let name = app?.localizedName, !name.isEmpty, name != self.targetName {
                        self.targetName = name
                        self.log?.app = name
                        self.bar?.setTitle("\(agentName(self.agent)) is using \(name)")
                        self.state("running", ["started": Date().timeIntervalSince1970, "always": self.alwaysAllowed])
                    }
                }
            }
        }
        bar = WorkingBar(icon: smallIcon, title: "\(agentName(agent)) is using \(targetName)", onStop: { [weak self] in self?.stop(by: "person") })
        let log = StepLog(dir: runDir, app: targetName, agent: agent)
        if !CGPreflightScreenCaptureAccess() && !(selfTest && ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_LIVE_STILL"] != nil) {
            log.picturesNote = "To show \(targetName) live here, macOS needs Screen Recording for \(hostAppName()). Only this one window is shown, only on this Mac: nothing is recorded or sent. Once you allow it, it works from the next time an agent asks."
        }
        self.log = log
        bar?.log = log
        bar?.liveSource = { [weak self] in
            guard let self = self else { return (0, nil) }
            return (self.targetPid, self.frontWindow().flatMap { frame($0) })
        }
        log.onChange = { [weak self] in self?.bar?.refresh() }
        // started without a question: the person chose Always Allow for it before (or every app in Settings)
        let said = preapproved
            ? "Started without asking: you chose Always Allow for \(targetName) earlier (`dispatch computer allowed --forget \"\(targetName)\"` asks again)"
            : "You allowed \(agentName(agent)) to use \(targetName)"
        let first = log.begin(said)
        log.end(first, said, ok: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.picture(first) }
        bar?.show()
        // Esc anywhere stops it (the global monitor needs the Accessibility permission it already has)
        if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in if e.keyCode == 53 { self?.stop(by: "person") } }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            if e.keyCode == 53 { self?.stop(by: "person"); return nil }
            return e
        }) { monitors.append(m) }
        state("running", ["started": Date().timeIntervalSince1970, "always": alwaysAllowed])
        if listenFd < 0 { listen() }
        // the app quits: the session ends then and there
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let self = self, let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.processIdentifier == self.targetPid else { return }
            self.stop(by: "app-quit")
        }
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self = self, !self.finished else { return }
            if Date().timeIntervalSince(self.lastCommand) > self.idleSeconds { self.stop(by: "idle") }
            if let t = self.target, t.isTerminated { self.stop(by: "app-quit") }
        }
    }

    func stop(by: String) {
        guard !finished, bar != nil else { return }
        let message: [String: String] = [
            "person": "The person stopped it. Do not start again on your own: tell them where you got to and ask what to do next.",
            "agent": "Stopped.",
            "idle": "Stopped after ten minutes without a command. Start again (the person is asked again) if there is more to do.",
            "app-quit": "\(targetName) quit, so the session ended.",
        ]
        var extra: [String: Any] = ["reason": by, "message": message[by] ?? "Stopped."]
        let last: [String: String] = [
            "person": "You stopped it", "agent": "\(agentName(agent)) finished", "idle": "Ended after ten quiet minutes", "app-quit": "\(targetName) quit",
        ]
        if let log = log {
            log.ended = last[by] ?? "Ended"
            let id = log.begin(log.ended!)
            log.end(id, log.ended!, ok: true)
            extra["steps"] = log.count - 2
            if !log.dir.isEmpty { extra["page"] = log.dir + "/index.html" }
        }
        giveBackNow()
        state("stopped", extra)
        bar?.finish(by == "person" ? "Stopped. \(targetName) is yours again." : "\(agentName(agent)) is done with \(targetName)")
        finished = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.end(nil) }
    }

    func end(_ status: String?, keepState: Bool = false) {
        finished = true
        for m in monitors { NSEvent.removeMonitor(m) }
        ask?.close()
        bar?.close()
        if log != nil && !onEnd.isEmpty && !ranOnEnd {
            ranOnEnd = true
            let p = Process()
            p.executableURL = URL(fileURLWithPath: onEnd[0])
            p.arguments = Array(onEnd.dropFirst())
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()  // it outlives this helper: no waiting
        }
        // after the answer to the command that ended it has gone out
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if self.listenFd >= 0 {
                close(self.listenFd)
                // only our own socket: a session started right after this one has its socket at the same path
                var st = stat()
                if stat(self.socketPath, &st) == 0 && st.st_ino == self.socketInode { unlink(self.socketPath) }
            }
            exit(0)
        }
    }

    // MARK: socket

    func listen() {
        unlink(socketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { state("error", ["message": "socket path too long"]); exit(1) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, len) } }
        guard ok == 0, Darwin.listen(fd, 8) == 0 else { state("error", ["message": "could not listen on \(socketPath)"]); exit(1) }
        chmod(socketPath, 0o600)
        var st = stat()
        if stat(socketPath, &st) == 0 { socketInode = st.st_ino }
        listenFd = fd
        Thread.detachNewThread { [weak self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { return }
                var data = Data()
                var buf = [UInt8](repeating: 0, count: 65536)
                while !data.contains(10) {
                    let n = read(c, &buf, buf.count)
                    if n <= 0 { break }
                    data.append(contentsOf: buf[0..<n])
                }
                var reply: [String: Any] = ["ok": false, "error": "bad request"]
                if let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let self = self {
                    // the step goes on the list first, so the bar shows it while it happens
                    var id = 0
                    DispatchQueue.main.sync { id = self.beginStep(obj) }
                    DispatchQueue.main.sync { reply = self.handle(obj); self.endStep(id, obj, reply) }
                }
                let out = Array((jsonLine(reply) + "\n").utf8)
                _ = out.withUnsafeBufferPointer { write(c, $0.baseAddress, $0.count) }
                close(c)
            }
        }
    }

    // MARK: the steps, in plain words

    func quoted(_ index: Int?) -> String {
        guard let i = index else { return "it" }
        return "“\(short(snapshot?.labels[i] ?? "item \(i)", 40))”"
    }

    func endName(_ spec: Any?) -> String {
        guard let d = spec as? [String: Any] else { return "it" }
        if let i = d["index"] as? Int { return quoted(i) }
        if let x = num(d["x"]), let y = num(d["y"]) { return "the point \(Int(x)), \(Int(y))" }
        return "it"
    }

    func isSecure(_ el: AXUIElement?) -> Bool {
        guard let e = el else { return false }
        return axString(e, kAXSubroleAttribute) == "AXSecureTextField"
    }

    func focusedElement() -> AXUIElement? {
        guard let f = axAttr(appElement, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else { return nil }
        return (f as! AXUIElement)
    }

    static func keyLabel(_ spec: String) -> String {
        let marks = ["cmd": "⌘", "command": "⌘", "meta": "⌘", "ctrl": "⌃", "control": "⌃", "alt": "⌥", "option": "⌥", "opt": "⌥", "shift": "⇧"]
        var out = ""
        for part in spec.split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if let m = marks[part.lowercased()] { out += m } else { out += part.count == 1 ? part.uppercased() : part.prefix(1).uppercased() + part.dropFirst() }
        }
        return out
    }

    /// What a command is, said three ways: while it happens, when it worked, when it did not.
    func words(_ req: [String: Any]) -> (doing: String, done: String, tried: String)? {
        let cmd = req["cmd"] as? String ?? ""
        switch cmd {
        case "look":
            return ("Looking at the window", "Looked at the window", "Tried to look at the window")
        case "click":
            let what = req["index"] != nil ? quoted(req["index"] as? Int) : endName(req)
            let right = (req["button"] as? String) == "right"
            let n = req["count"] as? Int ?? 1
            let verb = right ? "right-click" : (n == 2 ? "double-click" : "click")
            let cap = verb.prefix(1).uppercased() + verb.dropFirst()
            return ("\(cap)ing \(what)", "\(cap)ed \(what)", "Tried to \(verb) \(what)")
        case "fill":
            let i = req["index"] as? Int
            if isSecure(i.flatMap { snapshot?.elements[$0] }) {
                return ("Filling in a password", "Filled in a password", "Tried to fill in a password")
            }
            let v = short(req["value"] as? String ?? "", 50)
            return ("Filling in \(quoted(i))", "Filled \(quoted(i)) with “\(v)”", "Tried to fill in \(quoted(i))")
        case "type":
            if isSecure(focusedElement()) { return ("Typing a password", "Typed a password", "Tried to type a password") }
            let t = short(req["text"] as? String ?? "", 50)
            return ("Typing “\(t)”", "Typed “\(t)”", "Tried to type “\(t)”")
        case "press":
            let k = Session.keyLabel(req["key"] as? String ?? "")
            return ("Pressing \(k)", "Pressed \(k)", "Tried to press \(k)")
        case "scroll":
            let d = req["direction"] as? String ?? "down"
            return ("Scrolling \(d)", "Scrolled \(d)", "Tried to scroll \(d)")
        case "drag":
            let a = endName(req["from"]), b = endName(req["to"])
            return ("Dragging \(a) onto \(b)", "Dragged \(a) onto \(b)", "Tried to drag \(a) onto \(b)")
        case "menu":
            let path = (req["path"] as? [String] ?? []).joined(separator: " › ")
            if path.isEmpty { return ("Reading the menu bar", "Read the menu bar", "Tried to read the menu bar") }
            return ("Opening \(path)", "Chose \(path)", "Tried to choose \(path)")
        default:
            return nil
        }
    }

    func beginStep(_ req: [String: Any]) -> Int {
        // quiet: the CLI looking up a name before it clicks, not a step of its own
        guard let log = log, bar != nil, !finished, req["quiet"] as? Bool != true, let w = words(req) else { return 0 }
        return log.begin(w.doing)
    }

    func endStep(_ id: Int, _ req: [String: Any], _ reply: [String: Any]) {
        guard id != 0, let log = log, let w = words(req) else { return }
        let ok = reply["ok"] as? Bool ?? false
        var text = w.done
        let cmd = req["cmd"] as? String ?? ""
        if ok, cmd == "menu" {
            let path = (req["path"] as? [String] ?? []).joined(separator: " › ")
            if let label = reply["label"] as? String { text = "Chose \(label)" }  // the item's own name, quotes and all
            else { text = path.isEmpty ? "Read the menu bar" : "Read the \(path) menu" }
        }
        // a point: say what was there
        let said = { (on: String) -> String in on.hasPrefix("the ") || on.hasPrefix("a ") ? on : "“\(on)”" }
        if ok, cmd == "click", req["index"] == nil, let on = reply["on"] as? String {
            text = text.replacingOccurrences(of: endName(req), with: said(on))
        }
        if ok, cmd == "drag" {
            if let f = reply["from_on"] as? String, (req["from"] as? [String: Any])?["index"] == nil { text = text.replacingOccurrences(of: endName(req["from"]), with: said(f)) }
            if let t = reply["to_on"] as? String, (req["to"] as? [String: Any])?["index"] == nil { text = text.replacingOccurrences(of: endName(req["to"]), with: said(t)) }
        }
        if !ok {
            var why = (reply["error"] as? String ?? "").components(separatedBy: ". ").first ?? ""
            while why.hasSuffix(".") { why.removeLast() }
            text = w.tried + (why.isEmpty ? "" : ": " + short(why, 90))
        }
        log.end(id, text, ok: ok)
        if reply["in_front"] as? Bool == true { log.markFront(id) }
        bar?.stepped(at: ok ? lastPoint : nil)
        lastPoint = nil
        if ok { picture(id) }
    }

    /// A small picture of the app's window after the step, when macOS allows screen pictures.
    func picture(_ id: Int) {
        guard let log = log, !log.dir.isEmpty, targetPid != 0, log.picturesNote == nil else { return }
        let pid = targetPid
        let path = log.dir + "/step-\(id).jpg"
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.35) {
            if windowShot(pid: pid, to: path) {
                DispatchQueue.main.async { log.attach(id, shot: path) }
            }
        }
    }

    // MARK: commands

    func handle(_ req: [String: Any]) -> [String: Any] {
        let cmd = req["cmd"] as? String ?? ""
        if cmd == "ping" {
            return ["ok": true, "status": bar == nil ? "asking" : (finished ? "stopped" : "running"), "app": targetName,
                    "expanded": bar?.expanded ?? false, "pinned": bar?.pinned ?? false,
                    "live": bar?.steps.live.isLive ?? false, "live_frames": bar?.steps.live.frames ?? 0]
        }
        if cmd == "ui" && selfTest { return pressOwnButton(req["button"] as? String ?? "") }
        if cmd == "render" && selfTest { return renderOwnWindows(req["dir"] as? String ?? "/tmp") }
        if bar == nil && ask != nil && !finished {
            return ["ok": false, "code": "asking", "error": "The person has not answered yet: wait for Allow before you act."]
        }
        guard bar != nil, !finished else { return ["ok": false, "code": "not-running", "error": "No app is in use: start with `dispatch computer start <app> --why …` (the person is asked)."] }
        lastCommand = Date()
        if cmd != "stop" && screenLocked() {
            return ["ok": false, "code": "screen-locked", "error": lockedMessage]
        }
        noteFront()
        var reply = run(cmd, req)
        if cmd != "stop" { afterFront(&reply, settle: !["look", "scroll", "fill"].contains(cmd)) }
        return reply
    }

    func run(_ cmd: String, _ req: [String: Any]) -> [String: Any] {
        switch cmd {
        case "stop": stop(by: "agent"); return ["ok": true]
        case "look": return look(req)
        case "click": return click(req)
        case "drag": return drag(req)
        case "menu": return menu(req["path"] as? [String] ?? [])
        case "fill": return fill(req["index"] as? Int ?? 0, req["value"] as? String ?? "")
        case "type": return typeText(req["text"] as? String ?? "")
        case "press": return press(req["key"] as? String ?? "")
        case "scroll": return scroll(req["direction"] as? String ?? "down", req["amount"] as? Int ?? 5)
        default: return ["ok": false, "error": "unknown command \(cmd)"]
        }
    }

    var appElement: AXUIElement { AXUIElementCreateApplication(targetPid) }

    func look(_ req: [String: Any]) -> [String: Any] {
        guard targetPid != 0 else { return ["ok": false, "error": "\(targetName) is still opening; try again in a moment."] }
        let snap = Snapshot()
        var windows = axAttr(appElement, kAXWindowsAttribute) as? [AXUIElement] ?? []
        // real windows first (Finder lists the box you rename a file in as a window of its own)
        windows = windows.filter { axString($0, kAXRoleAttribute) == "AXWindow" } + windows.filter { axString($0, kAXRoleAttribute) != "AXWindow" }
        if let f = frontWindow() {
            windows.removeAll(where: { CFEqual($0, f) })
            windows.insert(f, at: 0)
        }
        snap.focused = focusedElement()
        if windows.isEmpty {
            let err = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, UnsafeMutablePointer<CFTypeRef?>.allocate(capacity: 1))
            if err == .apiDisabled { return ["ok": false, "code": "needs-permission", "error": "macOS no longer allows this app to use other apps (Accessibility is off)."] }
            return ["ok": true, "app": targetName, "text": "(\(targetName) has no open window)", "count": 0]
        }
        if req["frames"] as? Bool == true, let first = frontWindow(), let o = frame(first)?.origin { snap.origin = o }
        for w in windows.prefix(3) { snap.walk(w, depth: 0) }
        snapshot = snap
        var out: [String: Any] = ["ok": true, "app": targetName, "text": snap.lines.joined(separator: "\n"), "count": snap.count]
        if snap.count >= snap.limit { out["note"] = "The window has more than \(snap.limit) parts; only the first \(snap.limit) are listed." }
        if snap.origin != nil { out["note"] = ((out["note"] as? String).map { $0 + " " } ?? "") + "@x,y is each part's top-left corner and wxh its size, in points from the top-left corner of the first window; click or drag to x,y uses the same points." }
        if req["screenshot"] as? Bool == true, let path = req["path"] as? String {
            let shot = screenshot(path)
            for (k, v) in shot { out["shot_" + k] = v }
        }
        return out
    }

    func element(_ index: Int) -> AXUIElement? { snapshot?.elements[index] }

    func click(_ req: [String: Any]) -> [String: Any] {
        let button = (req["button"] as? String ?? "left").lowercased()
        let count = max(1, min(req["count"] as? Int ?? 1, 3))
        let plain = button == "left" && count == 1
        // a point: always a real click, and only on this app
        if req["index"] == nil {
            guard let x = num(req["x"]), let y = num(req["y"]) else { return ["ok": false, "error": "Say what to click: a number from look, a name, or a point x,y."] }
            return mouseClick(spec: "\(Int(x)),\(Int(y))", point: { self.windowPoint(x, y) }, button: button, count: count)
        }
        let index = req["index"] as? Int ?? 0
        guard let el = element(index) else { return ["ok": false, "error": "There is no [\(index)] in the last look; look again first."] }
        let name = snapshot?.labels[index] ?? "[\(index)]"
        if plain {
            var names: CFArray?
            AXUIElementCopyActionNames(el, &names)
            let actions = (names as? [String]) ?? []
            if let f = frame(el) { lastPoint = CGPoint(x: f.midX, y: f.midY) }
            if actions.contains(kAXPressAction) && AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
                return ["ok": true, "did": "pressed \(name)"]
            }
            for a in ["AXConfirm", "AXPick", "AXOpen"] where actions.contains(a) {
                if AXUIElementPerformAction(el, a as CFString) == .success {
                    return ["ok": true, "did": "\(a) on \(name)"]
                }
            }
            // a row in a list (or something inside one): select it through Accessibility, in the background
            if let row = rowOf(el) {
                var settable: DarwinBoolean = false
                if AXUIElementIsAttributeSettable(row, kAXSelectedAttribute as CFString, &settable) == .success, settable.boolValue,
                   AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success {
                    return ["ok": true, "did": "selected \(name)"]
                }
            }
        }
        // no press action, a double or a right click: a real click in the middle of it, with the app in front
        return mouseClick(spec: "“\(short(name, 40))”", point: {
            guard let f = frame(el) else { return .failure("\(name) has no position on the screen.") }
            return .success(CGPoint(x: f.midX, y: f.midY))
        }, button: button, count: count)
    }

    enum Where { case success(CGPoint), failure(String) }

    /// The list row this element is, or is inside (a few levels up at most).
    func rowOf(_ el: AXUIElement) -> AXUIElement? {
        var cur: AXUIElement? = el
        for _ in 0..<4 {
            guard let c = cur else { return nil }
            if axString(c, kAXRoleAttribute) == "AXRow" { return c }
            guard let parent = axAttr(c, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
            cur = (parent as! AXUIElement)
        }
        return nil
    }

    func num(_ v: Any?) -> CGFloat? {
        if let n = v as? NSNumber { return CGFloat(n.doubleValue) }
        if let s = v as? String, let d = Double(s) { return CGFloat(d) }
        return nil
    }

    /// The app's front window: the one `look` lists first and points are measured from.
    func frontWindow() -> AXUIElement? {
        if let focused = axAttr(appElement, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
           axString(focused as! AXUIElement, kAXRoleAttribute) == "AXWindow" {
            return (focused as! AXUIElement)
        }
        return (axAttr(appElement, kAXWindowsAttribute) as? [AXUIElement])?.first(where: { axString($0, kAXRoleAttribute) == "AXWindow" })
    }

    func windowPoint(_ x: CGFloat, _ y: CGFloat) -> Where {
        guard let w = frontWindow(), let f = frame(w) else { return .failure("\(targetName) has no open window to measure x,y from.") }
        return .success(CGPoint(x: f.minX + x, y: f.minY + y))
    }

    /// What a person would call the thing at this point: its title, description or text.
    func hitName(_ p: CGPoint) -> String? {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let el = hit else { return nil }
        if isSecure(el) { return "a password field" }
        let role = axString(el, kAXRoleAttribute)
        // a file's name box says the file's name; a note's text is not a name
        let keys = role == "AXTextArea" ? [kAXTitleAttribute, kAXDescriptionAttribute] : [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
        for key in keys {
            let v = axString(el, key)
            if !v.isEmpty { return short(v, 40) }
        }
        return role == "AXTextArea" ? "the text" : nil
    }

    /// Whose window is at this point right now: only the approved app may be clicked.
    func refuseIfNotOurs(_ p: CGPoint) -> String? {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let el = hit else {
            return "Nothing of \(targetName) is at \(Int(p.x)),\(Int(p.y)) on the screen."
        }
        var pid: pid_t = 0
        AXUIElementGetPid(el, &pid)
        if pid == targetPid { return nil }
        if pid == getpid() { return "That point is under Dispatch's bar at the top of the screen, not on \(targetName)." }
        let other = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "another app"
        return "That point is on \(other), not \(targetName); agents only click in the app the person allowed. Look again: the window may have moved."
    }

    func mouseClick(spec: String, point: () -> Where, button: String, count: Int) -> [String: Any] {
        guard targetPid != 0 else { return ["ok": false, "error": "\(targetName) is still opening; try again in a moment."] }
        guard takeFront() else { return ["ok": false, "error": systemAsking ? "A window from macOS itself is open (a password or a question), so \(targetName) can't come to the front; wait until the person has dealt with it." : "\(targetName) did not come to the front, so nothing was clicked."] }
        let p: CGPoint
        switch point() {
        case .failure(let why): return ["ok": false, "error": why]
        case .success(let q): p = q
        }
        if let why = refuseIfNotOurs(p) { return ["ok": false, "code": "not-this-app", "error": why] }
        let on = hitName(p)
        lastPoint = p
        let back = CGEvent(source: nil)?.location
        let (down, up, mb): (CGEventType, CGEventType, CGMouseButton) = button == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        postMouse(.mouseMoved, p, .left)
        usleep(40_000)
        for n in 1...count {
            postMouse(down, p, mb, clicks: n)
            usleep(30_000)
            postMouse(up, p, mb, clicks: n)
            usleep(60_000)
        }
        if let b = back { putPointerBack(b) }
        let kind = button == "right" ? "right-clicked" : (count == 2 ? "double-clicked" : (count == 3 ? "triple-clicked" : "clicked"))
        var out: [String: Any] = ["ok": true, "did": "\(kind) \(spec)" + (on.map { " (“\($0)”)" } ?? "") + ", at \(Int(p.x)),\(Int(p.y)) on the screen"]
        if let o = on { out["on"] = o }
        return out
    }

    func postMouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int = 1) {
        guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        if clicks > 1 { e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
        e.post(tap: .cghidEventTap)
    }

    /// The pointer goes back to where the person left it.
    func putPointerBack(_ p: CGPoint) {
        usleep(80_000)
        CGWarpMouseCursorPosition(p)
        CGAssociateMouseAndMouseCursorPosition(1)
    }

    func dragEnd(_ spec: [String: Any]?) -> (String, Where) {
        guard let s = spec else { return ("?", .failure("Say where the drag starts and ends.")) }
        if let i = s["index"] as? Int {
            guard let el = element(i) else { return ("[\(i)]", .failure("There is no [\(i)] in the last look; look again first.")) }
            let name = "“\(short(snapshot?.labels[i] ?? "[\(i)]", 40))”"
            guard let f = frame(el) else { return (name, .failure("\(name) has no position on the screen.")) }
            return (name, .success(CGPoint(x: f.midX, y: f.midY)))
        }
        guard let x = num(s["x"]), let y = num(s["y"]) else { return ("?", .failure("Say where the drag starts and ends: a number from look, a name, or x,y.")) }
        return ("\(Int(x)),\(Int(y))", windowPoint(x, y))
    }

    func drag(_ req: [String: Any]) -> [String: Any] {
        guard targetPid != 0 else { return ["ok": false, "error": "\(targetName) is still opening; try again in a moment."] }
        let (fromName, fromWhere) = dragEnd(req["from"] as? [String: Any])
        let (toName, toWhere) = dragEnd(req["to"] as? [String: Any])
        guard takeFront() else { return ["ok": false, "error": systemAsking ? "A window from macOS itself is open (a password or a question), so \(targetName) can't come to the front; wait until the person has dealt with it." : "\(targetName) did not come to the front, so nothing was dragged."] }
        var a = CGPoint.zero, b = CGPoint.zero
        switch fromWhere { case .failure(let why): return ["ok": false, "error": why]; case .success(let p): a = p }
        switch toWhere { case .failure(let why): return ["ok": false, "error": why]; case .success(let p): b = p }
        for p in [a, b] {
            if let why = refuseIfNotOurs(p) { return ["ok": false, "code": "not-this-app", "error": why] }
        }
        let hitFrom = hitName(a), hitTo = hitName(b)
        lastPoint = b
        let back = CGEvent(source: nil)?.location
        postMouse(.mouseMoved, a, .left)
        usleep(60_000)
        postMouse(.leftMouseDown, a, .left)
        usleep(200_000)  // a press that lasts: apps tell a drag from a click by it
        let steps = 24
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            postMouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), .left)
            usleep(16_000)
        }
        usleep(350_000)  // over the target long enough for it to light up
        postMouse(.leftMouseDragged, b, .left)
        usleep(50_000)
        postMouse(.leftMouseUp, b, .left)
        if let p = back { putPointerBack(p) }
        return ["ok": true, "did": "dragged \(fromName) to \(toName)"]
            .merging(hitTo.map { ["to_on": $0] } ?? [:]) { a, _ in a }
            .merging(hitFrom.map { ["from_on": $0] } ?? [:]) { a, _ in a }
    }

    // MARK: menus

    func menuTitle(_ el: AXUIElement) -> String { axString(el, kAXTitleAttribute) }

    func norm(_ s: String) -> String {
        // quotes and dots do not count: 新建“访达”窗口 is found as 新建访达窗口, Go to Folder… as Go to Folder
        var t = s.replacingOccurrences(of: "…", with: "...").trimmingCharacters(in: .whitespaces)
        for q in ["“", "”", "\"", "「", "」", "‘", "’", "'"] { t = t.replacingOccurrences(of: q, with: "") }
        while t.hasSuffix(".") { t.removeLast() }
        return t.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// The items under a menu bar entry or a menu item with a submenu.
    func items(of el: AXUIElement) -> [AXUIElement] {
        let role = axString(el, kAXRoleAttribute)
        let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
        if role == "AXMenuBar" || role == "AXMenu" { return kids }
        if let menu = kids.first(where: { axString($0, kAXRoleAttribute) == "AXMenu" }) {
            return axAttr(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []
        }
        return []
    }

    func shortcut(_ el: AXUIElement) -> String {
        var ch = axString(el, "AXMenuItemCmdChar")
        // arrows and other special keys come as private characters: name them by their key instead
        if let u = ch.unicodeScalars.first, u.value < 0x21 || (0xF700...0xF8FF).contains(u.value) {
            let code = (axAttr(el, "AXMenuItemCmdVirtualKey") as? NSNumber)?.intValue ?? -1
            ch = keyCodes.first(where: { Int($0.value) == code && $0.key.count > 1 })?.key ?? ""
        }
        guard !ch.isEmpty else { return "" }
        let mods = (axAttr(el, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
        // kAXMenuItemModifier: 1 shift, 2 option, 4 control, 8 no command
        var s = ""
        if mods & 4 != 0 { s += "ctrl+" }
        if mods & 2 != 0 { s += "option+" }
        if mods & 1 != 0 { s += "shift+" }
        if mods & 8 == 0 { s += "cmd+" }
        return s + ch.lowercased()
    }

    func menu(_ path: [String], again: Bool = false) -> [String: Any] {
        guard targetPid != 0 else { return ["ok": false, "error": "\(targetName) is still opening; try again in a moment."] }
        guard let barEl = axAttr(appElement, kAXMenuBarAttribute), CFGetTypeID(barEl) == AXUIElementGetTypeID() else {
            return ["ok": false, "error": "\(targetName) has no menu bar the agent can read."]
        }
        var node = barEl as! AXUIElement
        var walked: [String] = []
        var topItem: AXUIElement?
        for (depth, want) in path.enumerated() {
            let kids = items(of: node)
            // the Apple menu (shut down, log out, System Settings) and Services (other apps) are not this app
            let usable = depth == 0 ? Array(kids.dropFirst()) : kids
            guard let hit = usable.first(where: { norm(menuTitle($0)) == norm(want) })
                    ?? usable.first(where: { !menuTitle($0).isEmpty && norm(menuTitle($0)).hasPrefix(norm(want)) }) else {
                if depth == 0, let apple = kids.first, norm(menuTitle(apple)) == norm(want) {
                    return ["ok": false, "code": "refused", "error": "The Apple menu is for the whole Mac, not \(targetName); agents don't use it."]
                }
                let names = usable.map { menuTitle($0) }.filter { !$0.isEmpty }
                return ["ok": false, "code": "not-found", "error": "There is no “\(want)” in \(walked.isEmpty ? "the menu bar" : walked.joined(separator: " › ")). There is: \(names.joined(separator: ", "))"]
            }
            // Services sits in the app's own menu, under its name in the Mac's language
            if depth == 1 && ["services", "服务", "服務", "dienste", "services", "servicios", "サービス"].contains(norm(menuTitle(hit))) {
                return ["ok": false, "code": "refused", "error": "Services hands things to other apps; agents stay in \(targetName)."]
            }
            walked.append(menuTitle(hit))
            if depth == 0 { topItem = hit }
            node = hit
        }
        let role = axString(node, kAXRoleAttribute)
        let sub = items(of: node)
        if role == "AXMenuItem" && sub.isEmpty {
            // an item: choose it
            let label = walked.joined(separator: " › ")
            // an app in the background often shows its items greyed out until it is in front: bring it
            // forward and read the menu again (that is when the app updates its items)
            if (axAttr(node, kAXEnabledAttribute) as? Bool) == false {
                let greyed: [String: Any] = ["ok": false, "error": "\(label) is greyed out in \(targetName): it can't be chosen right now. Look at the window: something may need to be selected first."]
                guard !again, let top = topItem, takeFront() else { return greyed }
                // opening the menu is when the app works out what can be chosen: open it, choose, or close it again
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                AXUIElementPerformAction(top, kAXPressAction as CFString)
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
                let out = menu(path, again: true)
                if out["ok"] as? Bool != true, let open = items(of: top).isEmpty ? nil : (axAttr(top, kAXChildrenAttribute) as? [AXUIElement])?.first {
                    AXUIElementPerformAction(open, kAXCancelAction as CFString)
                }
                return out
            }
            var r = AXUIElementPerformAction(node, kAXPressAction as CFString)
            if r != .success, takeFront() { r = AXUIElementPerformAction(node, kAXPressAction as CFString) }
            guard r == .success else { return ["ok": false, "error": "\(targetName) did not take \(label) (\(r.rawValue))."] }
            return ["ok": true, "did": "chose \(label)", "label": label]
        }
        // a menu: list what is in it
        var lines: [String] = []
        for (i, el) in sub.enumerated() {
            if path.isEmpty && i == 0 { continue }  // the Apple menu
            let t = menuTitle(el)
            if t.isEmpty { continue }  // separators
            var line = t
            if !items(of: el).isEmpty && !path.isEmpty { line += " ›" }
            let sc = path.isEmpty ? "" : shortcut(el)
            if !sc.isEmpty { line += "  (\(sc))" }
            if let enabled = axAttr(el, kAXEnabledAttribute) as? Bool, !enabled, !path.isEmpty { line += "  (greyed out)" }
            lines.append(line)
        }
        let head = walked.isEmpty ? "\(targetName)'s menu bar:" : walked.joined(separator: " › ") + ":"
        return ["ok": true, "app": targetName, "text": ([head] + lines.map { "  " + $0 }).joined(separator: "\n"), "items": lines]
    }

    // MARK: in front only for a moment

    /// Most steps work through Accessibility with the app in the background. Keys, a real click and a
    /// drag need it in front (and some apps come forward on their own, Finder for a new window): then
    /// the bar says so, and the app the person was in comes back a moment after the last such step,
    /// so a few steps in a row share one trip to the front. If the person brings the app forward
    /// themselves, it stays.
    var personApp: NSRunningApplication?
    var frontIsOurs = false
    var restoreWork: DispatchWorkItem?
    var frontBefore = false
    var lastCommandEnd = Date.distantPast
    var socketInode: ino_t = 0
    /// where the last step pointed on the screen (a click, a drop), for the ring on the live view
    var lastPoint: CGPoint?

    var targetInFront: Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid }

    /// Before a command: whose front is it?
    func noteFront() {
        restoreWork?.cancel()
        restoreWork = nil
        let f = NSWorkspace.shared.frontmostApplication
        if let f = f, f.processIdentifier != targetPid, f.processIdentifier != getpid() {
            personApp = f
            frontIsOurs = false
        } else if f?.processIdentifier == targetPid, !frontIsOurs {
            // in front without us bringing it: the person went there themselves if they used the keyboard
            // or mouse since our last step; otherwise it came forward late from that step (Finder does)
            let sinceInput = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
            if sinceInput < Date().timeIntervalSince(lastCommandEnd) { personApp = nil } else { frontIsOurs = true }
        }
        frontBefore = targetInFront
    }

    /// After a command: if the app is in front because of us, give the front back soon.
    func afterFront(_ reply: inout [String: Any], settle: Bool) {
        defer { lastCommandEnd = Date() }
        // apps come forward a moment after they are asked to (Finder for Go to Folder): let the news arrive
        let until = Date().addingTimeInterval(settle ? 0.25 : 0)
        while !targetInFront && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.03)) }
        guard targetInFront, personApp.map({ !$0.isTerminated }) == true else { return }
        if !frontBefore { reply["in_front"] = true }
        frontIsOurs = true
        let work = DispatchWorkItem { [weak self] in self?.giveBackSoon() }
        restoreWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
    }

    /// A password or Touch ID window of macOS is up: the person is busy with it, the front is theirs.
    var systemAsking: Bool {
        let id = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        return ["com.apple.SecurityAgent", "com.apple.LocalAuthentication.UIAgent", "com.apple.loginwindow", "com.apple.coreservices.uiagent"].contains(id)
    }

    func takeFront() -> Bool {
        if systemAsking { return false }
        if !targetInFront { bar?.note("Needs \(targetName) in front for a moment") }
        return bringToFront()
    }

    /// The app the person was in goes back in front, if the front is still ours to give.
    func giveBack() {
        restoreWork?.cancel()
        restoreWork = nil
        if frontIsOurs, targetInFront, let back = personApp, !back.isTerminated { back.activate() }
        frontIsOurs = false
        bar?.refresh()
    }

    func giveBackNow() { giveBack() }

    /// One exception to giving the front back at once: a one-line box the agent is typing a name into
    /// (Finder's rename box closes when Finder leaves the front). It goes back when that box is done,
    /// or ten seconds after the last step.
    func giveBackSoon() {
        if let f = focusedElement(), axString(f, kAXRoleAttribute) == "AXTextField", !isSecure(f),
           Date().timeIntervalSince(lastCommandEnd) < 10, frontIsOurs, targetInFront {
            let work = DispatchWorkItem { [weak self] in self?.giveBackSoon() }
            restoreWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
            return
        }
        giveBack()
    }

    func bringToFront() -> Bool {
        target?.activate()
        for _ in 0..<20 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return false
    }

    func fill(_ index: Int, _ value: String) -> [String: Any] {
        guard let el = element(index) else { return ["ok": false, "error": "There is no [\(index)] in the last look; look again first."] }
        let name = snapshot?.labels[index] ?? "[\(index)]"
        if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString) == .success {
            return ["ok": true, "did": "set \(name) to \(value.count) characters"]
        }
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let typed = typeText(value)
        return typed
    }

    /// Text in at the caret through Accessibility (what the selection is replaced with), when the box
    /// allows it and its text really changed. Not for password boxes: those only take keys.
    func insertText(_ el: AXUIElement, _ text: String) -> Bool {
        let role = axString(el, kAXRoleAttribute)
        guard ["AXTextArea", "AXTextField", "AXComboBox"].contains(role), !isSecure(el), !text.isEmpty else { return false }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(el, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
        let before = axString(el, kAXValueAttribute)
        guard AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { return false }
        return axString(el, kAXValueAttribute) != before
    }

    func typeText(_ text: String) -> [String: Any] {
        guard targetPid != 0 else { return ["ok": false, "error": "\(targetName) is still opening."] }
        // a text box that takes text through Accessibility gets it in the background: no keys, no front
        if let f = focusedElement(), insertText(f, text) {
            return ["ok": true, "did": "typed \(text.count) characters", "background": true]
        }
        // otherwise keys, which reach the box being edited only while its app is in front (Finder's
        // rename box); they are still sent to this app alone, so nothing typed elsewhere mixes in
        let front = takeFront()
        let units = Array(text.utf16)
        var i = 0
        while i < units.count {
            let chunk = Array(units[i..<min(i + 16, units.count)])
            for down in [true, false] {
                if let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) {
                    e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                    e.postToPid(targetPid)  // to this app only, whichever app is in front
                }
            }
            usleep(8_000)
            i += 16
        }
        var out: [String: Any] = ["ok": true, "did": "typed \(text.count) characters"]
        let box = focusedElement().map { axString($0, kAXRoleAttribute) } ?? ""
        out["focused"] = box
        if !front {
            out["note"] = "\(targetName) did not come to the front, so the text may not have landed: look to check."
        } else if !["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(box) {
            // no text box had the keyboard: the keys went to the window itself (Finder jumps to a file by its name)
            out["note"] = "No text box in \(targetName) had the keyboard, so the keys went to the window itself: look to check, and click into the box first."
        }
        return out
    }

    func press(_ key: String) -> [String: Any] {
        guard let (code, flags) = parseKey(key) else { return ["ok": false, "error": "Unknown key \(key). Use Return, Tab, Escape, Up, Down, Left, Right, Delete, or cmd+a style combinations."] }
        if code == 53 && flags.isEmpty { return ["ok": false, "error": "Esc is the person's stop key, so agents don't press it."] }
        let front = takeFront()
        for down in [true, false] {
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) {
                e.flags = flags
                e.postToPid(targetPid)
            }
            usleep(20_000)
        }
        var out: [String: Any] = ["ok": true, "did": "pressed \(key)"]
        if !front { out["note"] = "\(targetName) did not come to the front, so the key may not have landed: look to check." }
        return out
    }

    func scroll(_ direction: String, _ amount: Int) -> [String: Any] {
        let n = Int32(max(1, min(amount, 50)))
        let dy: Int32 = direction == "up" ? n : (direction == "down" ? -n : 0)
        let dx: Int32 = direction == "left" ? n : (direction == "right" ? -n : 0)
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.postToPid(targetPid)
        return ["ok": true, "did": "scrolled \(direction)"]
    }

    func screenshot(_ path: String) -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else {
            return ["error": "No picture: macOS has not allowed screen pictures for \(hostAppName()) (Privacy & Security > Screen Recording). The list above is enough to work with."]
        }
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let win = infos.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == targetPid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
              let wid = win[kCGWindowNumber as String] as? Int else { return ["error": "\(targetName) has no window on screen."] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l\(wid)", path]
        try? p.run()
        p.waitUntilExit()
        return FileManager.default.fileExists(atPath: path) ? ["path": path] : ["error": "The picture could not be taken."]
    }

    // MARK: self-test

    func ownButtons() -> [PillButton] {
        (ask?.buttons ?? []) + (bar.map { [$0.stopButton] } ?? [])
    }

    func pressOwnButton(_ title: String) -> [String: Any] {
        if ["show steps", "hide steps", "pin steps", "unpin steps"].contains(title.lowercased()), let b = bar {
            if ["show steps", "pin steps"].contains(title.lowercased()) != b.pinned { b.toggle() }
            return ["ok": true, "expanded": b.expanded, "pinned": b.pinned]
        }
        guard let b = ownButtons().first(where: { $0.title.lowercased() == title.lowercased() && !$0.isHidden }) else {
            return ["ok": false, "error": "no button \(title)", "buttons": ownButtons().map { $0.title }]
        }
        b.performClick(nil)
        return ["ok": true]
    }

    func renderOwnWindows(_ dir: String) -> [String: Any] {
        var out: [String: Any] = ["ok": true]
        if let a = ask, let v = a.panel.contentView { out["ask"] = savePNG(of: v, to: dir + "/ask.png")["path"] ?? "" }
        if let b = bar, let v = b.panel.contentView { out["bar"] = savePNG(of: v, to: dir + "/bar.png")["path"] ?? "" }
        if let b = bar, b.expanded, let v = b.steps.panel.contentView { out["steps"] = savePNG(of: v, to: dir + "/steps.png")["path"] ?? "" }
        return out
    }
}

func savePNG(of view: NSView, to path: String) -> [String: Any] {
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return ["error": "no image"] }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let data = rep.representation(using: .png, properties: [:]) else { return ["error": "no png"] }
    do { try data.write(to: URL(fileURLWithPath: path)) } catch { return ["error": "\(error)"] }
    return ["path": path]
}

// MARK: - Entry

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "help"

switch command {
case "check":
    let host = hostAppName()
    printJSON(["ok": true, "accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess(), "host": host, "selftest": selfTest])
case "version":
    printJSON(["ok": true, "protocol": helperProtocol])
case "apps":
    let apps = regularApps().map { app -> [String: Any] in
        var o: [String: Any] = ["name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier),
                                "front": app.isActive]
        if let reason = blockReason(bundleId: app.bundleIdentifier, name: app.localizedName ?? "") { o["refused"] = reason }
        return o
    }
    var all = apps
    if selfTest { all.append(["name": practiceAppName, "bundle": "dev.dispatch.practice-notes", "pid": Int(getpid()), "front": false]) }
    printJSON(["ok": true, "apps": all])
case "practice":
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let notes = PracticeNotes(out: argValue(args, "--out") ?? "/dev/null")
    notes.report()
    if let dir = argValue(args, "--render") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { _ = savePNG(of: notes.window.contentView!, to: dir) }
    }
    signal(SIGTERM) { _ in exit(0) }
    withExtendedLifetime(notes) { app.run() }
case "serve":
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    if selfTest, let look = ProcessInfo.processInfo.environment["DISPATCH_COMPUTER_APPEARANCE"] {
        app.appearance = NSAppearance(named: look == "light" ? .aqua : .darkAqua)  // pictures of both looks
    }
    let session = Session(args: args)
    DispatchQueue.main.async { session.start() }
    withExtendedLifetime(session) { app.run() }
default:
    print("usage: dispatch-computer check | apps | version | serve --app A --agent NAME --why TEXT --socket PATH --state FILE")
    exit(command == "help" ? 0 : 2)
}
