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
        // The place mounts after the banner on a slow runner.
        XCTAssertTrue(element("mobile-inbox-home").waitForExistence(timeout: 15))
    }

    /// Every place in the system's bar, photographed and left on Home again.
    @MainActor
    private func visitPlaces() {
        for (tab, screen) in [
            ("Threads", "mobile-threads"),
            ("Inbox", "mobile-inbox"),
            ("Home", "mobile-inbox-home"),
        ] {
            // By the name VoiceOver says: the system bar's items carry no identifier.
            tap(app.tabBars.buttons[tab])
            XCTAssertTrue(element(screen).waitForExistence(timeout: 15))
            let evidence = XCTAttachment(screenshot: app.screenshot())
            evidence.name = "Place \(screen)"
            evidence.lifetime = .keepAlways
            add(evidence)
            // Rows pass under the place's bar, which has to keep its name readable.
            app.swipeUp()
            let scrolled = XCTAttachment(screenshot: app.screenshot())
            scrolled.name = "Place \(screen) scrolled"
            scrolled.lifetime = .keepAlways
            add(scrolled)
            app.swipeDown()
        }
    }

    /// The filter's and a row's own menus, photographed open.
    @MainActor
    private func openMenus() {
        tap(app.tabBars.buttons["Threads"])
        let filter = element("mobile-threads-filter-host")
        tap(filter)
        let host = app.buttons["Studio Mac"].firstMatch
        let opened = host.waitForExistence(timeout: 15)
        let evidence = XCTAttachment(screenshot: app.screenshot())
        evidence.name = "Filter menu"
        evidence.lifetime = .keepAlways
        add(evidence)
        XCTAssertTrue(opened)
        tap(host)
        let row = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "mobile-home-thread-row-code")
        ).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.press(forDuration: 1.2)
        let settle = app.buttons["Settle"].firstMatch
        let offered = settle.waitForExistence(timeout: 15)
        let menu = XCTAttachment(screenshot: app.screenshot())
        menu.name = "Row menu"
        menu.lifetime = .keepAlways
        add(menu)
        XCTAssertTrue(offered)
        // Outside the menu and the lifted row, which closes it and changes nothing.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)).tap()
        XCTAssertTrue(settle.waitForNonExistence(timeout: 15))
        tap(app.tabBars.buttons["Home"])
    }

    @MainActor
    private func createReply(_ prompt: String) {
        // New beside the bar starts a thread from every place.
        // In the system bar where it has a place for New, else a button over the list.
        tap(app.buttons["New thread"].firstMatch)
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
        // The computer is a menu here, which says what it chooses before the choice.
        XCTAssertTrue(host.label.hasSuffix("Studio Mac"), host.label)
        XCTAssertGreaterThan(project.frame.width, 0)
        XCTAssertGreaterThan(host.frame.width, 0)
        XCTAssertTrue(context.frame.contains(project.frame))
        let contextBounds = context.frame
        let hostBounds = host.frame
        let contextEdges = [Double(contextBounds.minX), Double(contextBounds.minY), Double(contextBounds.maxX), Double(contextBounds.maxY)]
        let hostEdges = [Double(hostBounds.minX), Double(hostBounds.minY), Double(hostBounds.maxX), Double(hostBounds.maxY)]
        // The shared bottom edge differed by 0.000019 points, one adjacent
        // Float32 value after native origin/size rounding; other edges stay exact.
        let hostContained = !contextBounds.isEmpty && !hostBounds.isEmpty &&
            contextEdges.allSatisfy(\.isFinite) && hostEdges.allSatisfy(\.isFinite) &&
            Float(contextBounds.maxY).isFinite && Float(hostBounds.maxY).isFinite &&
            contextBounds.minX <= hostBounds.minX && contextBounds.minY <= hostBounds.minY &&
            contextBounds.maxX >= hostBounds.maxX &&
            Float(hostBounds.maxY) <= Float(contextBounds.maxY).nextUp
        if !hostContained {
            let evidence = XCTAttachment(screenshot: app.screenshot())
            evidence.name = "Context host containment failure"
            evidence.lifetime = .keepAlways
            add(evidence)
        }
        XCTAssertTrue(hostContained, "Edges [minX, minY, maxX, maxY]: context \(contextEdges) must contain host \(hostEdges)")
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
        let reply = app.descendants(matching: .any).matching(
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
        // Answering stays in view too: the thread's composer rides on the keyboard.
        let followUp = element("mobile-composer-input")
        tap(followUp)
        XCTAssertTrue(keyboard.waitForExistence(timeout: 15))
        XCTAssertTrue(followUp.isHittable)
        XCTAssertLessThanOrEqual(followUp.frame.maxY, keyboard.frame.minY)
        let answering = XCTAttachment(screenshot: app.screenshot())
        answering.name = "Thread composer above the system keyboard"
        answering.lifetime = .keepAlways
        add(answering)
    }

    @MainActor
    func testColdDemoReplyForegroundAndReset() {
        app.launch()
        enterDemo()
        visitPlaces()
        createReply("Native iOS sample reply")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(element("mobile-thread-screen").waitForExistence(timeout: 15))
        XCTAssertTrue(element("mobile-mock-banner").exists)
        tap(element("mobile-demo-leave"))
        enterDemo()
        XCTAssertFalse(app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "Native iOS sample reply")
        ).firstMatch.exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(element("mobile-entry-demo").waitForExistence(timeout: 15))
        app.terminate()
    }

    @MainActor
    func testDarkPlacesAndMenus() {
        app.launch()
        enterDemo()
        visitPlaces()
        openMenus()
        createReply("Native iOS dark reply")
        app.terminate()
    }

    @MainActor
    func testLargeTextEntryAndReply() {
        app.launch()
        enterDemo()
        visitPlaces()
        createReply("Native iOS large text reply")
        tap(element("mobile-demo-leave"))
        XCTAssertTrue(element("mobile-entry-demo").waitForExistence(timeout: 15))
        app.terminate()
    }

    /// Drives the app through steps a person writes, for looking at a screen by
    /// hand on another Mac. The acceptance run gives none, and skips it.
    @MainActor
    func testDriveByHand() throws {
        let steps = ProcessInfo.processInfo.environment["OCTANT_DRIVE_STEPS"] ?? ""
        try XCTSkipIf(steps.isEmpty, "No steps were given.")
        app.launch()
        for step in steps.components(separatedBy: ";") {
            let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
            let target = parts.count > 1 ? parts[1] : ""
            // By identifier, else by the words VoiceOver says.
            let named = element(target)
            let control = named.exists ? named : app.descendants(matching: .any).matching(
                NSPredicate(format: "label BEGINSWITH %@", target)
            ).firstMatch
            switch parts.first ?? "" {
            case "demo": enterDemo()
            case "tap": _ = control.waitForExistence(timeout: 10); control.tap()
            case "tab": tap(app.tabBars.buttons[target])
            case "press": _ = control.waitForExistence(timeout: 10); control.press(forDuration: 1.2)
            case "left": control.swipeLeft()
            case "right": control.swipeRight()
            case "up": app.swipeUp()
            case "down": app.swipeDown()
            case "type": app.typeText(target)
            case "wait": Thread.sleep(forTimeInterval: Double(target) ?? 1)
            case "shot":
                let picture = XCTAttachment(screenshot: app.screenshot())
                picture.name = target
                picture.lifetime = .keepAlways
                add(picture)
            default: XCTFail("Unknown step \(step)")
            }
        }
    }
}
