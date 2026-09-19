import Foundation

/// One key to press: a USB HID keyboard usage, held under Shift or not.
struct KeyStroke: Equatable {
    let usage: UInt64
    let shifted: Bool
}

enum HardwareButton: String {
    case home
    case lock

    /// Consumer-page usages the guest maps to its hardware buttons.
    var usage: (page: UInt64, code: UInt64) {
        switch self {
        case .home: return (0x0C, 0x40)
        case .lock: return (0x0C, 0x30)
        }
    }
}

enum KeyUsages {
    static let leftShift: UInt64 = 225

    /// Named keys a request may carry. Home and Lock are buttons, not keys.
    static let named: [String: UInt64] = [
        "return": 40, "enter": 40, "escape": 41, "delete": 42, "backspace": 42,
        "tab": 43, "space": 44, "right": 79, "left": 80, "down": 81, "up": 82,
    ]

    /// The keystrokes that type `text`, or nil when a character has none.
    ///
    /// A usage names a key position, and the guest turns it into a character
    /// with its own hardware layout — which follows the Simulator's keyboard
    /// language, not the Mac's. Observed on a Norwegian Simulator: usage 45
    /// typed "+", not "-". Letters, digits, space and Return sit on the same
    /// positions across the QWERTY family, so those are the characters typed;
    /// anything else is refused rather than typed wrong.
    static func strokes(for text: String) -> [KeyStroke]? {
        var strokes: [KeyStroke] = []
        for character in text {
            guard let stroke = stroke(for: character) else { return nil }
            strokes.append(stroke)
        }
        return strokes
    }

    private static func stroke(for character: Character) -> KeyStroke? {
        guard let ascii = character.asciiValue else { return nil }
        switch ascii {
        case UInt8(ascii: "a")...UInt8(ascii: "z"):
            return KeyStroke(usage: UInt64(ascii - UInt8(ascii: "a")) + 4, shifted: false)
        case UInt8(ascii: "A")...UInt8(ascii: "Z"):
            return KeyStroke(usage: UInt64(ascii - UInt8(ascii: "A")) + 4, shifted: true)
        case UInt8(ascii: "1")...UInt8(ascii: "9"):
            return KeyStroke(usage: UInt64(ascii - UInt8(ascii: "1")) + 30, shifted: false)
        case UInt8(ascii: "0"): return KeyStroke(usage: 39, shifted: false)
        case UInt8(ascii: " "): return KeyStroke(usage: 44, shifted: false)
        case UInt8(ascii: "\n"): return KeyStroke(usage: 40, shifted: false)
        default: return nil
        }
    }
}
