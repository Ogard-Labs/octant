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
        tap(element("mobile-entry-demo"))
        XCTAssertTrue(element("mobile-mock-banner").waitForExistence(timeout: 15))
        XCTAssertTrue(element("mobile-inbox-home").exists)
    }

    @MainActor
    private func createReply(_ prompt: String) {
        tap(app.buttons["Plan, ask, build"])
        let input = element("mobile-home-composer-input")
        tap(input)
        input.typeText(prompt)
        tap(element("mobile-home-composer-submit"))
        XCTAssertTrue(element("mobile-thread-screen").waitForExistence(timeout: 15))
        let reply = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Mock reply to: " + prompt)
        ).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15))
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
