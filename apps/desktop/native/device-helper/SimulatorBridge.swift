import Darwin
import Foundation

/// Why the helper could not reach a Simulator. Each case is a refusal the
/// desktop reports as-is; none of them is retried inside the helper.
enum BridgeRefusal: Error {
    case toolchainUnavailable(String)
    case noSuchDevice
    case notBooted(String)
    case inputServiceUnavailable(String)
}

/// The slice of CoreSimulator this helper needs: find one device by UDID and
/// ask its launchd for a guest service port.
///
/// CoreSimulator is a private framework, so nothing here links against it. It
/// is loaded at run time from the path Xcode installs it to, and every call
/// goes through `objc_msgSend` with the selector's real C signature. A Mac
/// without Xcode therefore gets `toolchainUnavailable`, not a launch failure.
struct SimulatorBridge {
    private static let coreSimulatorPath =
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
    private static let bootedState = 3

    let device: NSObject

    var name: String { device.value(forKey: "name") as? String ?? "Simulator" }

    var stateDescription: String {
        (device.value(forKey: "stateString") as? String) ?? "unknown"
    }

    var isBooted: Bool {
        (device.value(forKey: "state") as? NSNumber)?.intValue == Self.bootedState
    }

    /// The Simulator's first keyboard, as the guest records it — for example
    /// `nb_NO@sw=QWERTY-Norwegian;hw=Automatic` — or its first language when no
    /// keyboard has been shown yet. Read from the device's own preference files;
    /// nil when neither is there.
    var keyboardIdentifier: String? {
        // CoreSimulator has vended this as a path string and as a file URL in
        // different releases; either names the same directory.
        let vended = device.value(forKey: "dataPath")
        guard let dataPath = (vended as? String) ?? (vended as? URL)?.path else { return nil }
        let preferences = (dataPath as NSString).appendingPathComponent("Library/Preferences")
        let keyboard = NSDictionary(
            contentsOfFile: (preferences as NSString).appendingPathComponent(
                "com.apple.keyboard.preferences.plist"))
        if let first = (keyboard?["KeyboardsCurrentAndNext"] as? [String])?.first { return first }
        let global = NSDictionary(
            contentsOfFile: (preferences as NSString).appendingPathComponent(".GlobalPreferences.plist"))
        if let first = (global?["AppleKeyboards"] as? [String])?.first { return first }
        return (global?["AppleLanguages"] as? [String])?.first
    }

    /// The main screen in pixels — the space a captured screenshot is in — so a
    /// caller can turn a point on a capture into a fraction of the screen.
    var screenPixelSize: CGSize? {
        guard let deviceType = device.value(forKey: "deviceType") as? NSObject,
            let size = (deviceType.value(forKey: "mainScreenSize") as? NSValue)?.sizeValue,
            size.width > 0, size.height > 0
        else { return nil }
        return size
    }

    static func device(udid: String, developerDirectory: String) throws -> SimulatorBridge {
        guard dlopen(coreSimulatorPath, RTLD_NOW) != nil else {
            throw BridgeRefusal.toolchainUnavailable(String(cString: dlerror()))
        }
        guard let contextClass = NSClassFromString("SimServiceContext") else {
            throw BridgeRefusal.toolchainUnavailable("SimServiceContext is missing")
        }
        typealias ContextFor = @convention(c) (
            AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>?
        ) -> AnyObject?
        typealias DeviceSetOf = @convention(c) (
            AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?
        ) -> AnyObject?
        var failure: NSError?
        let context = try send(ContextFor.self)(
            contextClass,
            NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
            developerDirectory as NSString,
            &failure
        )
        guard let context else {
            throw BridgeRefusal.toolchainUnavailable(failure?.localizedDescription ?? "no service context")
        }
        let deviceSet = try send(DeviceSetOf.self)(
            context, NSSelectorFromString("defaultDeviceSetWithError:"), &failure
        )
        guard let deviceSet = deviceSet as? NSObject,
            let devices = deviceSet.value(forKey: "devices") as? [NSObject]
        else {
            throw BridgeRefusal.toolchainUnavailable(failure?.localizedDescription ?? "no device set")
        }
        let wanted = udid.uppercased()
        guard
            let match = devices.first(where: {
                ($0.value(forKey: "UDID") as? UUID)?.uuidString == wanted
            })
        else { throw BridgeRefusal.noSuchDevice }
        return SimulatorBridge(device: match)
    }

    /// The Mach port of a service registered in the guest's launchd, or a
    /// refusal naming why the guest does not vend it.
    func guestServicePort(named service: String) throws -> mach_port_t {
        guard isBooted else { throw BridgeRefusal.notBooted(stateDescription) }
        typealias Lookup = @convention(c) (
            AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>?
        ) -> mach_port_t
        var failure: NSError?
        let port = try Self.send(Lookup.self)(
            device, NSSelectorFromString("lookup:error:"), service as NSString, &failure
        )
        guard port != 0 else {
            throw BridgeRefusal.inputServiceUnavailable(
                failure?.localizedDescription ?? "the guest does not vend \(service)")
        }
        return port
    }

    private static func send<Signature>(_ signature: Signature.Type) throws -> Signature {
        // RTLD_DEFAULT: search every image already loaded into the process.
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
            throw BridgeRefusal.toolchainUnavailable("objc_msgSend is missing")
        }
        return unsafeBitCast(symbol, to: signature)
    }
}
