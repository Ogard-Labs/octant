import AVFoundation
import Darwin
import Foundation
import Speech

// Octant speech helper: turns one recorded clip into text with Apple's
// on-device dictation model, reports whether that model is on this Mac, and
// downloads it when asked. One process serves one request and exits.
//
// The request arrives on stdin as a 4-byte big-endian length, one JSON object,
// and, for a transcription, the clip itself as raw 16 kHz mono 16-bit PCM. The
// audio is never in an argument, an environment value or a file. Answers leave
// on stdout, one JSON object per line. Nothing is written to stderr, so no
// audio, transcript or dictionary term can reach a log.
//
// Only `SpeechAnalyzer` modules are used here. Apple documents that they do
// not send the person's voice to Apple's servers and that the speech
// recognition permission applies only to `SFSpeechRecognizer`, which this
// helper never calls.

private let protocolVersion = 1
private let maximumHeaderBytes = 65_536
private let maximumAudioBytes = 4_200_000
private let maximumContextualStrings = 100
private let sampleRate = 16_000.0

private enum Refusal: String, Error {
    case malformed
    case unsupportedLanguage = "unsupported-language"
    case notInstalled = "not-installed"
    case failed
}

private struct Request {
    let operation: String
    let language: String?
    let contextualStrings: [String]
    let audio: Data
}

private func readExactly(_ count: Int) -> Data? {
    var data = Data(count: count)
    var offset = 0
    while offset < count {
        let received = data.withUnsafeMutableBytes { bytes in
            read(STDIN_FILENO, bytes.baseAddress! + offset, count - offset)
        }
        if received < 0 && errno == EINTR { continue }
        if received <= 0 { return nil }
        offset += received
    }
    return data
}

private func readRequest() throws -> Request {
    guard let header = readExactly(4) else { throw Refusal.malformed }
    let length = header.reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length <= maximumHeaderBytes, let payload = readExactly(length),
        let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
        object["protocolVersion"] as? Int == protocolVersion,
        let operation = object["operation"] as? String
    else { throw Refusal.malformed }
    let contextualStrings = object["contextualStrings"] as? [String] ?? []
    guard contextualStrings.count <= maximumContextualStrings else { throw Refusal.malformed }
    var audio = Data()
    if operation == "transcribe" {
        guard let bytes = object["audioBytes"] as? Int, bytes > 0, bytes % 2 == 0,
            bytes <= maximumAudioBytes, let received = readExactly(bytes)
        else { throw Refusal.malformed }
        audio = received
    }
    return Request(
        operation: operation, language: object["language"] as? String,
        contextualStrings: contextualStrings, audio: audio)
}

private func answer(_ response: [String: Any]) {
    guard var line = try? JSONSerialization.data(withJSONObject: response) else { exit(1) }
    line.append(0x0A)
    line.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let written = write(STDOUT_FILENO, bytes.baseAddress! + offset, bytes.count - offset)
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { exit(1) }
            offset += written
        }
    }
}

/// The host holds stdin open while it wants an answer. Its end means the
/// person cancelled or the host is gone, so nothing here may outlive it.
private func exitWhenHostLeaves() {
    Thread.detachNewThread {
        var byte: UInt8 = 0
        while true {
            let received = read(STDIN_FILENO, &byte, 1)
            if received < 0 && errno == EINTR { continue }
            if received <= 0 { _exit(0) }
        }
    }
}

@available(macOS 26.0, *)
private func supportedLocale(_ language: String?) async throws -> Locale {
    // Apple's recognizer detects no language. With none chosen it listens for
    // the first one the person set for this Mac.
    let wanted = Locale.Language(
        identifier: language ?? Locale.preferredLanguages.first ?? Locale.current.identifier)
    var candidates = [wanted]
    if wanted.region == nil {
        // A bare language matches whichever region Apple lists first (French
        // became fr-CA), so the person's own region for it wins, and then the
        // region most of its speakers use.
        let own = Locale.preferredLanguages.map { Locale.Language(identifier: $0) }
            .filter { $0.languageCode == wanted.languageCode && $0.region != nil }
        candidates = own + [Locale.Language(identifier: wanted.maximalIdentifier), wanted]
    }
    for candidate in candidates {
        let locale = Locale(
            languageCode: candidate.languageCode, languageRegion: candidate.region)
        if let found = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            return found
        }
    }
    throw Refusal.unsupportedLanguage
}

@available(macOS 26.0, *)
private func transcriber(_ locale: Locale) -> DictationTranscriber {
    DictationTranscriber(
        locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
        reportingOptions: [], attributeOptions: [])
}

@available(macOS 26.0, *)
private func isInstalled(_ locale: Locale, _ module: DictationTranscriber) async -> Bool {
    // A model another app or system dictation already brought is listed as
    // installed while the asset status for this process still says otherwise.
    let installed = await DictationTranscriber.installedLocales
    if installed.contains(where: { $0.identifier == locale.identifier }) { return true }
    return await AssetInventory.status(forModules: [module]) == .installed
}

@available(macOS 26.0, *)
private func status(_ locale: Locale) async {
    let module = transcriber(locale)
    let state: String
    if await isInstalled(locale, module) {
        state = "installed"
    } else if await AssetInventory.status(forModules: [module]) == .unsupported {
        state = "unsupported-language"
    } else {
        state = "absent"
    }
    answer(["event": "status", "state": state, "language": locale.identifier(.bcp47)])
}

@available(macOS 26.0, *)
private func download(_ locale: Locale) async throws {
    let module = transcriber(locale)
    if !(await isInstalled(locale, module)) {
        let reserved = await AssetInventory.reservedLocales
        if reserved.count >= AssetInventory.maximumReservedLocales,
            !reserved.contains(where: { $0.identifier == locale.identifier }),
            let oldest = reserved.first
        {
            await AssetInventory.release(reservedLocale: oldest)
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            let reporting = Task {
                while !Task.isCancelled {
                    answer(["event": "progress", "fraction": request.progress.fractionCompleted])
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            defer { reporting.cancel() }
            try await request.downloadAndInstall()
        }
        guard await isInstalled(locale, module) else { throw Refusal.notInstalled }
    }
    answer(["event": "downloaded", "language": locale.identifier(.bcp47)])
}

private func buffer(_ audio: Data) throws -> AVAudioPCMBuffer {
    let frames = AVAudioFrameCount(audio.count / 2)
    guard
        let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: false),
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
        let samples = buffer.int16ChannelData?[0]
    else { throw Refusal.failed }
    buffer.frameLength = frames
    audio.withUnsafeBytes { bytes in
        UnsafeMutableRawPointer(samples).copyMemory(
            from: bytes.baseAddress!, byteCount: audio.count)
    }
    return buffer
}

private func converted(_ input: AVAudioPCMBuffer, to format: AVAudioFormat) throws
    -> AVAudioPCMBuffer
{
    if input.format == format { return input }
    let ratio = format.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 1_024
    guard let converter = AVAudioConverter(from: input.format, to: format),
        let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)
    else { throw Refusal.failed }
    var supplied = false
    var failure: NSError?
    let outcome = converter.convert(to: output, error: &failure) { _, provided in
        if supplied {
            provided.pointee = .endOfStream
            return nil
        }
        supplied = true
        provided.pointee = .haveData
        return input
    }
    guard outcome != .error, failure == nil else { throw Refusal.failed }
    return output
}

@available(macOS 26.0, *)
private func transcribe(_ locale: Locale, _ request: Request) async throws {
    let module = transcriber(locale)
    guard await isInstalled(locale, module) else { throw Refusal.notInstalled }
    let recording = try buffer(request.audio)
    guard
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [module], considering: recording.format)
    else { throw Refusal.failed }
    let clip = try converted(recording, to: format)
    let context = AnalysisContext()
    context.contextualStrings[.general] = request.contextualStrings
    let analyzer = SpeechAnalyzer(modules: [module])
    try await analyzer.setContext(context)
    let (inputs, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
    feed.yield(AnalyzerInput(buffer: clip))
    feed.finish()
    let reading = Task {
        var text = ""
        for try await result in module.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }
    if let end = try await analyzer.analyzeSequence(inputs) {
        try await analyzer.finalizeAndFinish(through: end)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    answer(["event": "transcript", "text": try await reading.value])
}

@main
private struct OctantSpeechHelper {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            answer(["event": "refused", "code": "unsupported-system"])
            return
        }
        do {
            // A host that stalls mid-request cannot leave the helper waiting.
            alarm(30)
            let request = try readRequest()
            exitWhenHostLeaves()
            let locale = try await supportedLocale(request.language)
            switch request.operation {
            case "status": await status(locale)
            case "download":
                alarm(1_800)
                try await download(locale)
            case "transcribe":
                alarm(120)
                try await transcribe(locale, request)
            default: throw Refusal.malformed
            }
        } catch let refusal as Refusal {
            answer(["event": "refused", "code": refusal.rawValue])
        } catch {
            // Apple's own message is not relayed: what it names is not bounded.
            answer(["event": "refused", "code": Refusal.failed.rawValue])
        }
    }
}
