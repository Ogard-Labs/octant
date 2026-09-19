import CoreImage
import Darwin
import Foundation
import IOSurface

enum DisplayRefusal: Error {
    case noDisplay(String)
}

/// Streams a booted Simulator's main display as JPEG frames.
///
/// The display is read where CoreSimulator already keeps it — an IOSurface the
/// render server presents into — so a frame costs one encode (measured: 1.7 ms
/// for a 1206×2622 screen scaled to 1100 high) instead of a `simctl` process
/// and a PNG on disk. Frames are produced only after the render server says it
/// presented one, at most `maximumFramesPerSecond`, and a frame is dropped
/// rather than queued while the previous one is still being written: a viewer
/// wants the newest screen, not every screen.
///
/// Calls into the display descriptor go through a remote proxy that can raise
/// an Objective-C exception Swift cannot catch. That ends this process; the
/// desktop sees the helper stop and starts a new one on the next request.
final class DisplayStream {
    private let descriptor: NSObject
    private let token = NSUUID()
    private let callbacks = DispatchQueue(label: "app.octant.device-helper.frames", qos: .userInteractive)
    private let encoder = DispatchQueue(label: "app.octant.device-helper.encode", qos: .userInitiated)
    private let context = CIContext(options: nil)
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private let lock = NSLock()
    private var running = false
    private var encoding = false
    private var dirty = false
    private var lastFrameAt = DispatchTime(uptimeNanoseconds: 0)
    private var maximumHeight = 1_100
    private var quality = 0.7
    private var minimumInterval: UInt64 = 1_000_000_000 / 30
    private var write: ((Data) -> Bool)?

    init(simulator: SimulatorBridge) throws {
        guard let io = simulator.device.value(forKey: "io") as? NSObject else {
            throw DisplayRefusal.noDisplay("the Simulator has no IO client")
        }
        typealias Ports = @convention(c) (AnyObject, Selector) -> AnyObject?
        typealias DisplayClass = @convention(c) (AnyObject, Selector) -> UInt16
        let send = try SimulatorBridge.messageSend(Ports.self)
        let sendClass = try SimulatorBridge.messageSend(DisplayClass.self)
        guard let ports = send(io, NSSelectorFromString("ioPorts")) as? [NSObject] else {
            throw DisplayRefusal.noDisplay("the Simulator lists no IO ports")
        }
        var fallback: NSObject?
        var main: NSObject?
        for port in ports {
            guard let candidate = send(port, NSSelectorFromString("descriptor")) as? NSObject,
                candidate.responds(to: NSSelectorFromString("framebufferSurface"))
                    || candidate.responds(to: NSSelectorFromString("ioSurface"))
            else { continue }
            // Class 0 is the device's own screen; others are external displays.
            var displayClass: UInt16 = .max
            if candidate.responds(to: NSSelectorFromString("state")),
                let state = send(candidate, NSSelectorFromString("state")),
                state.responds(to: NSSelectorFromString("displayClass"))
            {
                displayClass = sendClass(state, NSSelectorFromString("displayClass"))
            }
            if displayClass == 0 {
                main = candidate
                break
            }
            if fallback == nil { fallback = candidate }
        }
        guard let chosen = main ?? fallback else {
            throw DisplayRefusal.noDisplay("the Simulator exposes no display surface")
        }
        descriptor = chosen
    }

    /// Starts pushing frames to `write`, which returns false when the reader is gone.
    func start(maximumHeight: Int, quality: Double, framesPerSecond: Int, write: @escaping (Data) -> Bool) throws {
        lock.withLock {
            self.maximumHeight = maximumHeight
            self.quality = quality
            self.minimumInterval = 1_000_000_000 / UInt64(framesPerSecond)
            self.write = write
        }
        let alreadyRunning = lock.withLock { () -> Bool in
            defer { running = true }
            return running
        }
        if !alreadyRunning { try register() }
        // The screen as it is now: a still device presents no frame to wait for.
        frameArrived()
    }

    func stop() {
        let wasRunning = lock.withLock { () -> Bool in
            defer {
                running = false
                write = nil
            }
            return running
        }
        guard wasRunning else { return }
        typealias Unregister = @convention(c) (AnyObject, Selector, NSUUID) -> Void
        if let send = try? SimulatorBridge.messageSend(Unregister.self),
            descriptor.responds(to: NSSelectorFromString("unregisterScreenCallbacksWithUUID:"))
        {
            send(descriptor, NSSelectorFromString("unregisterScreenCallbacksWithUUID:"), token)
        }
    }

    private func register() throws {
        let selector = NSSelectorFromString(
            "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"
        )
        guard descriptor.responds(to: selector) else {
            throw DisplayRefusal.noDisplay("this toolchain's display does not report presented frames")
        }
        typealias Register = @convention(c) (
            AnyObject, Selector, NSUUID, DispatchQueue,
            // The render server keeps these blocks for as long as the callbacks
            // are registered; left non-escaping, Swift traps when it returns.
            @escaping @convention(block) () -> Void,
            @escaping @convention(block) (AnyObject?, AnyObject?) -> Void,
            @escaping @convention(block) (AnyObject?) -> Void
        ) -> Void
        let send = try SimulatorBridge.messageSend(Register.self)
        send(
            descriptor, selector, token, callbacks,
            { [weak self] in self?.frameArrived() },
            { [weak self] _, _ in self?.frameArrived() },
            { _ in })
    }

    /// Runs on the render server's notify path, which waits for it: it only
    /// marks the screen dirty and hands the encode to another queue.
    private func frameArrived() {
        let shouldEncode = lock.withLock { () -> Bool in
            guard running else { return false }
            dirty = true
            guard !encoding else { return false }
            encoding = true
            return true
        }
        if shouldEncode { encoder.async { [weak self] in self?.drain() } }
    }

    private func drain() {
        while true {
            let settings = lock.withLock { () -> (Int, Double, UInt64, ((Data) -> Bool)?)? in
                guard running, dirty else {
                    encoding = false
                    return nil
                }
                dirty = false
                return (maximumHeight, quality, minimumInterval, write)
            }
            guard let (height, quality, interval, write) = settings, let write else { return }
            let now = DispatchTime.now().uptimeNanoseconds
            let earliest = lastFrameAt.uptimeNanoseconds + interval
            if now < earliest { Thread.sleep(forTimeInterval: Double(earliest - now) / 1_000_000_000) }
            lastFrameAt = DispatchTime.now()
            guard let frame = encode(maximumHeight: height, quality: quality) else { continue }
            if !write(frame) {
                stop()
                lock.withLock { encoding = false }
                return
            }
        }
    }

    private func encode(maximumHeight: Int, quality: Double) -> Data? {
        typealias Surface = @convention(c) (AnyObject, Selector) -> AnyObject?
        guard let send = try? SimulatorBridge.messageSend(Surface.self) else { return nil }
        var value: AnyObject?
        if descriptor.responds(to: NSSelectorFromString("framebufferSurface")) {
            value = send(descriptor, NSSelectorFromString("framebufferSurface"))
        }
        if value == nil, descriptor.responds(to: NSSelectorFromString("ioSurface")) {
            value = send(descriptor, NSSelectorFromString("ioSurface"))
        }
        guard let surface = value as? IOSurface else { return nil }
        var image = CIImage(ioSurface: unsafeBitCast(surface, to: IOSurfaceRef.self))
        let height = image.extent.height
        if height > CGFloat(maximumHeight) {
            let scale = CGFloat(maximumHeight) / height
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        return context.jpegRepresentation(
            of: image, colorSpace: colorSpace,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality])
    }
}
