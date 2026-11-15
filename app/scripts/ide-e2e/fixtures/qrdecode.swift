// Reads the QR codes in a PNG with macOS's own CIDetector and prints each one's text on a line, for the phone
// pairing scenario (scenarios/mobile-pairing.mjs), which decodes the code from a real screenshot of the window.
//   qrdecode <file.png>      exits 1 when the picture has no code
// Built by the scenario on first use: swiftc -O -o qrdecode qrdecode.swift
import CoreImage
import Foundation

guard CommandLine.arguments.count == 2, let image = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("usage: qrdecode <file.png>\n".data(using: .utf8)!)
    exit(2)
}
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
let found = (detector?.features(in: image) ?? []).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
for text in found { print(text) }
exit(found.isEmpty ? 1 : 0)
