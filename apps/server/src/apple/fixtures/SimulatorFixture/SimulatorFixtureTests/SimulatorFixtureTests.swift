import XCTest
@testable import SimulatorFixture

final class SimulatorFixtureTests: XCTestCase {
    func testFixtureIdentity() {
        XCTAssertEqual("Octant Apple Fixture", "Octant Apple Fixture")
    }
}
