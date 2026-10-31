import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else { exit(1) }
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let dimension = CGFloat(pixels)
        NSColor(calibratedRed: 0.08, green: 0.14, blue: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: dimension, height: dimension), xRadius: dimension * 0.22, yRadius: dimension * 0.22).fill()
        for row in 0..<2 {
            for column in 0..<5 {
                NSColor(calibratedRed: 0.69, green: 0.91, blue: 0.79, alpha: 1).setFill()
                let card = NSRect(x: dimension * (0.14 + CGFloat(column) * 0.15), y: dimension * (0.27 + CGFloat(row) * 0.25), width: dimension * 0.11, height: dimension * 0.2)
                NSBezierPath(roundedRect: card, xRadius: dimension * 0.025, yRadius: dimension * 0.025).fill()
            }
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let filename = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(filename))
    }
}
