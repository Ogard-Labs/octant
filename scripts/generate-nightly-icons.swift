import CoreGraphics
import Foundation
import ImageIO

enum IconFailure: Error {
    case refused(String)
}

func pixels(_ image: CGImage) throws -> [UInt8] {
    // The canonical PNG and all eight ICNS images decode as unassociated RGBA8.
    // Refuse another layout rather than invert premultiplied colours into halos.
    guard image.bitsPerComponent == 8, image.bitsPerPixel == 32,
          image.bitmapInfo.rawValue == CGImageAlphaInfo.last.rawValue,
          image.colorSpace?.model == .rgb,
          image.width > 0, image.height > 0,
          image.width <= 1024, image.height <= 1024,
          let data = image.dataProvider?.data,
          CFDataGetLength(data) >= image.bytesPerRow * image.height
    else { throw IconFailure.refused("The canonical icon needs unassociated RGBA8 images.") }
    return [UInt8](data as Data)
}

func inverted(_ image: CGImage) throws -> CGImage {
    var bytes = try pixels(image)
    for y in 0..<image.height {
        for x in 0..<image.width {
            let offset = y * image.bytesPerRow + x * 4
            for channel in 0..<3 { bytes[offset + channel] = 255 - bytes[offset + channel] }
        }
    }
    guard let space = image.colorSpace,
          let provider = CGDataProvider(data: Data(bytes) as CFData),
          let result = CGImage(width: image.width, height: image.height,
                               bitsPerComponent: 8, bitsPerPixel: 32,
                               bytesPerRow: image.bytesPerRow, space: space,
                               bitmapInfo: image.bitmapInfo, provider: provider,
                               decode: nil, shouldInterpolate: image.shouldInterpolate,
                               intent: image.renderingIntent)
    else { throw IconFailure.refused("The Nightly icon could not be created.") }
    return result
}

func source(_ path: String) throws -> CGImageSource {
    guard let result = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          CGImageSourceGetCount(result) > 0, CGImageSourceGetCount(result) <= 16
    else { throw IconFailure.refused("The canonical icon could not be read.") }
    return result
}

func image(_ source: CGImageSource, _ index: Int) throws -> CGImage {
    guard let result = CGImageSourceCreateImageAtIndex(source, index, nil)
    else { throw IconFailure.refused("An icon representation could not be decoded.") }
    return result
}

func key(_ source: CGImageSource, _ index: Int, _ image: CGImage) -> String {
    let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [String: Any] ?? [:]
    let horizontal = (properties[kCGImagePropertyDPIWidth as String] as? NSNumber)?.intValue ?? 0
    let vertical = (properties[kCGImagePropertyDPIHeight as String] as? NSNumber)?.intValue ?? 0
    return "\(image.width)x\(image.height)@\(horizontal)x\(vertical)"
}

func verifyPixels(_ original: CGImage, _ result: CGImage) throws -> Int {
    guard original.width == result.width, original.height == result.height
    else { throw IconFailure.refused("Nightly changed an icon's dimensions.") }
    let before = try pixels(original), after = try pixels(result)
    for y in 0..<original.height {
        for x in 0..<original.width {
            let a = y * original.bytesPerRow + x * 4
            let b = y * result.bytesPerRow + x * 4
            guard before[a + 3] == after[b + 3]
            else { throw IconFailure.refused("Nightly changed the icon silhouette.") }
            // RGB under fully transparent pixels has no visible colour and may
            // be normalized by an image encoder. Alpha remains exact everywhere.
            if before[a + 3] > 0 {
                for channel in 0..<3 {
                    guard Int(before[a + channel]) + Int(after[b + channel]) == 255
                    else { throw IconFailure.refused("Nightly did not invert every visible colour.") }
                }
            }
        }
    }
    return original.width * original.height
}

func generate(_ input: String, _ output: String) throws {
    let original = try source(input)
    guard let type = CGImageSourceGetType(original),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL,
                                                          type, CGImageSourceGetCount(original), nil)
    else { throw IconFailure.refused("The native icon writer is unavailable.") }
    for index in 0..<CGImageSourceGetCount(original) {
        let converted = try inverted(image(original, index))
        CGImageDestinationAddImage(destination, converted,
                                   CGImageSourceCopyPropertiesAtIndex(original, index, nil))
    }
    guard CGImageDestinationFinalize(destination)
    else { throw IconFailure.refused("The native icon writer could not finish.") }
}

func verify(_ input: String, _ output: String) throws {
    let original = try source(input), result = try source(output)
    guard CGImageSourceGetType(original) == CGImageSourceGetType(result),
          CGImageSourceGetCount(original) == CGImageSourceGetCount(result)
    else { throw IconFailure.refused("Nightly changed the icon representation set.") }
    var representations: [String] = []
    var checked = 0
    for index in 0..<CGImageSourceGetCount(original) {
        let before = try image(original, index)
        let representation = key(original, index, before)
        guard let match = (0..<CGImageSourceGetCount(result)).first(where: { candidate in
            guard let decoded = try? image(result, candidate) else { return false }
            return key(result, candidate, decoded) == representation
        }) else { throw IconFailure.refused("Nightly lost an icon size or density.") }
        checked += try verifyPixels(before, image(result, match))
        representations.append(representation)
    }
    let report: [String: Any] = ["representations": representations, "pixels": checked,
                               "alphaExact": true, "visibleRGBInverted": true]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}

func selfTest() throws {
    let bytes: [UInt8] = [0, 19, 255, 0, 12, 34, 56, 64, 25, 120, 230, 128, 255, 0, 80, 255]
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
          let original = CGImage(width: 2, height: 2, bitsPerComponent: 8, bitsPerPixel: 32,
                                 bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                                 provider: provider, decode: nil, shouldInterpolate: false,
                                 intent: .defaultIntent)
    else { throw IconFailure.refused("The synthetic icon could not be created.") }
    _ = try verifyPixels(original, inverted(original))
    print("Synthetic transparent, translucent and opaque pixels preserve alpha and invert RGB.")
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["self-test"] { try selfTest() }
    else if arguments.count == 3, arguments[0] == "generate" {
        try generate(arguments[1], arguments[2])
    } else if arguments.count == 3, arguments[0] == "verify" {
        try verify(arguments[1], arguments[2])
    } else { throw IconFailure.refused("Use self-test, generate source destination, or verify source destination.") }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
