import XCTest
@testable import DesignSystem

final class PrimaryButtonTests: XCTestCase {
    func testColour() {
        XCTAssertNotNil(UIColor(red: 1, green: 0, blue: 0, alpha: 1))
    }
}
