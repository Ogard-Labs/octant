import XCTest

final class OfflineDemoTests: XCTestCase {
    @MainActor
    private var app: XCUIApplication { XCUIApplication(bundleIdentifier: "app.octant.mobile") }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @MainActor
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    @MainActor
    private func tap(_ control: XCUIElement) {
        XCTAssertTrue(control.waitForExistence(timeout: 15))
        XCTAssertTrue(control.isEnabled)
        XCTAssertTrue(control.isHittable)
        XCTAssertGreaterThan(control.frame.width, 0)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(control.frame))
        control.tap()
    }

    @MainActor
    private func enterDemo() {
        let demo = element("mobile-entry-demo")
        XCTAssertTrue(demo.waitForExistence(timeout: 15))
        let entry = element("mobile-entry")
        for _ in 0..<8 {
            if demo.isHittable && app.windows.firstMatch.frame.contains(demo.frame) { break }
            XCTAssertTrue(entry.isHittable)
            entry.swipeUp()
        }
        tap(demo)
        XCTAssertTrue(element("mobile-mock-banner").waitForExistence(timeout: 15))
        XCTAssertTrue(element("mobile-inbox-home").exists)
    }

    @MainActor
    private func createReply(_ prompt: String) {
        tap(app.buttons["Plan, ask, build"])
        let input = element("mobile-home-composer-input")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 15))
        tap(input)
        XCTAssertLessThanOrEqual(input.frame.maxY, keyboard.frame.minY)
        XCTAssertLessThanOrEqual(element("mobile-home-composer-submit").frame.maxY, keyboard.frame.minY)
        let context = element("mobile-home-composer-context")
        let project = element("mobile-home-composer-project-label")
        let host = element("mobile-home-composer-host-label")
        XCTAssertTrue(context.exists)
        XCTAssertTrue(project.exists)
        XCTAssertTrue(host.exists)
        XCTAssertEqual(project.label, "New conversation")
        XCTAssertEqual(host.label, "Studio Mac")
        XCTAssertGreaterThan(project.frame.width, 0)
        XCTAssertGreaterThan(host.frame.width, 0)
        XCTAssertTrue(context.frame.contains(project.frame))
        XCTAssertTrue(context.frame.contains(host.frame))
        XCTAssertTrue(app.windows.firstMatch.frame.contains(context.frame))
        XCTAssertFalse(project.frame.intersects(host.frame))
        XCTAssertLessThanOrEqual(context.frame.maxY, input.frame.minY)
        input.typeText(prompt)
        XCTAssertLessThanOrEqual(input.frame.maxY, keyboard.frame.minY)
        XCTAssertLessThanOrEqual(element("mobile-home-composer-submit").frame.maxY, keyboard.frame.minY)
        let composer = XCTAttachment(screenshot: app.screenshot())
        composer.name = "Typed composer and context above the system keyboard"
        composer.lifetime = .keepAlways
        add(composer)
        tap(element("mobile-home-composer-submit"))
        XCTAssertTrue(element("mobile-thread-screen").waitForExistence(timeout: 15))
        let reply = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Mock reply to: " + prompt)
        ).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15))
        let transcript = element("mobile-thread-transcript")
        let followUpComposer = element("mobile-thread-composer")
        XCTAssertTrue(transcript.exists)
        XCTAssertTrue(followUpComposer.exists)
        XCTAssertGreaterThan(transcript.frame.height, 0)
        // The shared edge arrived 0.000019 points apart from separately
        // rounded native origins/sizes; compare at their Float32 precision.
        XCTAssertLessThanOrEqual(Float(transcript.frame.maxY), Float(followUpComposer.frame.minY))
        // A long paragraph may exceed the viewport. Prove its beginning and
        // end can each be reached rather than requiring both at once.
        for _ in 0..<8 {
            if reply.frame.minY >= transcript.frame.minY && reply.frame.minY < transcript.frame.maxY { break }
            XCTAssertTrue(transcript.isHittable)
            if reply.frame.minY >= transcript.frame.maxY { transcript.swipeUp() }
            else { transcript.swipeDown() }
        }
        XCTAssertGreaterThanOrEqual(reply.frame.minY, transcript.frame.minY)
        XCTAssertLessThan(reply.frame.minY, transcript.frame.maxY)
        let beginning = XCTAttachment(screenshot: app.screenshot())
        beginning.name = "Native sample reply beginning"
        beginning.lifetime = .keepAlways
        add(beginning)
        for _ in 0..<8 {
            if reply.frame.maxY <= transcript.frame.maxY && reply.frame.maxY > transcript.frame.minY { break }
            XCTAssertTrue(transcript.isHittable)
            if reply.frame.maxY > transcript.frame.maxY { transcript.swipeUp() }
            else { transcript.swipeDown() }
        }
        XCTAssertLessThanOrEqual(reply.frame.maxY, transcript.frame.maxY)
        XCTAssertGreaterThan(reply.frame.maxY, transcript.frame.minY)
        let replied = XCTAttachment(screenshot: app.screenshot())
        replied.name = "Native sample reply"
        replied.lifetime = .keepAlways
        add(replied)
    }

    @MainActor
    func testColdDemoReplyForegroundAndReset() {
        app.launch()
        enterDemo()
        createReply("Native iOS sample reply")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(element("mobile-thread-screen").waitForExistence(timeout: 15))
        XCTAssertTrue(element("mobile-mock-banner").exists)
        tap(element("mobile-demo-leave"))
        enterDemo()
        XCTAssertFalse(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Native iOS sample reply")
        ).firstMatch.exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(element("mobile-entry-demo").waitForExistence(timeout: 15))
        app.terminate()
    }

    @MainActor
    func testLargeTextEntryAndReply() {
        app.launch()
        enterDemo()
        createReply("Native iOS large text reply")
        tap(element("mobile-demo-leave"))
        XCTAssertTrue(element("mobile-entry-demo").waitForExistence(timeout: 15))
        app.terminate()
    }
}
