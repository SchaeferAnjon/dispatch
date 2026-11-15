// The text on a screenshot and where it is (Apple's Vision, on this Mac), so first-run.sh can click a macOS button by
// its name instead of a fixed spot: Gatekeeper's and System Settings' dialogs move with what else is on screen.
// Prints one line per piece of text: X <tab> Y <tab> text, the middle of it in the picture's pixels. vm.sh compiles it.
import AppKit
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("ocr: cannot read \(url.path)\n".data(using: .utf8)!)
  exit(1)
}
let w = CGFloat(cg.width), h = CGFloat(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
try VNImageRequestHandler(cgImage: cg).perform([req])
for o in req.results ?? [] {
  guard let t = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  print("\(Int(b.midX * w))\t\(Int((1 - b.midY) * h))\t\(t.string)")
}
