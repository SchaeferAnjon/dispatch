// The person, for the real-app computer-use scenario (scenarios/computer-real-apps.mjs): clicks a button in a
// window of a given pid with the real mouse, presses a key on the real keyboard (HID level, so global
// monitors see it), moves the pointer, and says which app is in front and where the pointer is.
//   person click <pid> <title> | find <pid> <title> | key esc|return | move <x> <y> | mouse | frontmost | activate <pid>
// Build: swiftc -O -o person person.swift
import AppKit
import ApplicationServices
func attr(_ el: AXUIElement, _ n: String) -> AnyObject? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil }
func find(_ el: AXUIElement, _ title: String, _ d: Int = 0) -> AXUIElement? {
    if d > 30 { return nil }
    let t = (attr(el, kAXTitleAttribute) as? String) ?? (attr(el, kAXDescriptionAttribute) as? String) ?? ""
    if (attr(el, kAXRoleAttribute) as? String) == "AXButton" && t == title { return el }
    for c in (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let h = find(c, title, d + 1) { return h } }
    return nil
}
func frame(_ el: AXUIElement) -> CGRect {
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(attr(el, kAXPositionAttribute) as! AXValue, .cgPoint, &p); AXValueGetValue(attr(el, kAXSizeAttribute) as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}
let a = CommandLine.arguments
switch a[1] {
case "click", "find":
    let app = AXUIElementCreateApplication(pid_t(a[2])!)
    var hit: AXUIElement?
    for _ in 0..<50 {
        for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { if let h = find(w, a[3]) { hit = h; break } }
        if hit != nil { break }
        usleep(100_000)
    }
    guard let b = hit else { print("{\"ok\":false}"); exit(1) }
    let f = frame(b); let p = CGPoint(x: f.midX, y: f.midY)
    if a[1] == "find" { print("{\"ok\":true,\"x\":\(Int(p.x)),\"y\":\(Int(p.y))}"); exit(0) }
    let back = CGEvent(source: nil)!.location
    for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap); usleep(60_000)
    }
    CGWarpMouseCursorPosition(back)
    print("{\"ok\":true,\"x\":\(Int(p.x)),\"y\":\(Int(p.y))}")
case "key":
    let code: CGKeyCode = a[2] == "esc" ? 53 : 36
    for d in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: d)!.post(tap: .cghidEventTap); usleep(30_000) }
    print("{\"ok\":true}")
case "move":
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
    print("{\"ok\":true}")
case "mouse":
    let l = CGEvent(source: nil)!.location
    print("{\"x\":\(Int(l.x)),\"y\":\(Int(l.y))}")
case "activate":
    if let app = NSRunningApplication(processIdentifier: pid_t(a[2])!) { app.activate() }
    usleep(300_000)
    print("{\"ok\":true}")
case "frontmost":
    let f = NSWorkspace.shared.frontmostApplication
    print("{\"name\":\"\(f?.localizedName ?? "")\",\"pid\":\(f?.processIdentifier ?? 0)}")
default: break
}
